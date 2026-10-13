/**
 * scripts/seed.ts
 *
 * Loads Phase 0's seed_curriculum.json and domain_scorelist.json into
 * Supabase. Uses the SERVICE ROLE key (bypasses RLS) since this is a
 * one-time admin operation, not a user-facing request.
 *
 * Usage:
 *   npx tsx scripts/seed.ts
 *
 * Idempotent: re-running this updates existing rows (matched by
 * external_key / domain) rather than creating duplicates, so it's safe
 * to run again after editing the source JSON files.
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { join } from "path";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment."
  );
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceRoleKey);

// Seed files live in the project root, one level up from app/.
const SEED_CURRICULUM_PATH = join(__dirname, "../../seed_curriculum.json");
const DOMAIN_SCORELIST_PATH = join(__dirname, "../../domain_scorelist.json");

async function seedCurriculum() {
  const raw = JSON.parse(readFileSync(SEED_CURRICULUM_PATH, "utf-8"));

  console.log(`Seeding curriculum: ${raw.curriculum.title}`);

  // Upsert the curriculum itself. No external_key/unique constraint on
  // curricula in the schema, so we match on title to stay idempotent.
  const { data: existing } = await supabase
    .from("curricula")
    .select("id")
    .eq("title", raw.curriculum.title)
    .maybeSingle();

  let curriculumId: string;

  if (existing) {
    curriculumId = existing.id;
    await supabase
      .from("curricula")
      .update({
        subject: raw.curriculum.subject,
        source_type: raw.curriculum.source_type,
        source_attribution: raw.curriculum.source_attribution,
        source_url: raw.curriculum.source_url,
        notes: raw.curriculum.notes,
        status: "published", // ensure published for demo visibility
      })
      .eq("id", curriculumId);
    console.log(`  Updated existing curriculum (${curriculumId})`);
  } else {
    const { data, error } = await supabase
      .from("curricula")
      .insert({
        title: raw.curriculum.title,
        subject: raw.curriculum.subject,
        source_type: raw.curriculum.source_type,
        source_attribution: raw.curriculum.source_attribution,
        source_url: raw.curriculum.source_url,
        notes: raw.curriculum.notes,
        status: "published", // published for demo visibility
      })
      .select("id")
      .single();

    if (error) throw error;
    curriculumId = data.id;
    console.log(`  Created new curriculum (${curriculumId})`);
  }

  // Upsert each node (topic) and its major understandings.
  for (const node of raw.nodes) {
    const { data: nodeRow, error: nodeError } = await supabase
      .from("nodes")
      .upsert(
        {
          curriculum_id: curriculumId,
          external_key: node.node_id,
          title: node.title,
          order_index: node.order_index,
          exam_weight_pct: node.exam_weight_pct ?? null,
          claim_statement: node.claim_statement ?? null,
        },
        { onConflict: "curriculum_id,external_key" }
      )
      .select("id")
      .single();

    if (nodeError) throw nodeError;

    const muList = node.major_understandings ?? node.sub_points ?? [];

    for (let i = 0; i < muList.length; i++) {
      const mu = muList[i];
      const { error: muError } = await supabase.from("major_understandings").upsert(
        {
          node_id: nodeRow.id,
          external_key: mu.key ?? mu.pe_code ?? `${node.node_id}-${i}`,
          code: mu.code ?? mu.pe_code ?? null,
          description: mu.description,
          order_index: i,
        },
        { onConflict: "node_id,external_key" }
      );

      if (muError) throw muError;
    }

    console.log(`  Topic "${node.title}": ${muList.length} major understandings`);
  }

  // Seed curated demo resources for topics 1-3.
  // Uses external_key for idempotent upserts (requires migration 0004).
  console.log("  Seeding curated demo resources...");
  const nodeIds: string[] = [];
  for (const node of raw.nodes) {
    const { data: nodeRow } = await supabase
      .from("nodes")
      .select("id")
      .eq("curriculum_id", curriculumId)
      .eq("external_key", node.node_id)
      .single();
    if (nodeRow) nodeIds.push(nodeRow.id);
  }

  // Collect all seed resources from the JSON
  const seedResources: Array<{
    node_id: string;
    external_key: string;
    url: string;
    title: string;
    source_domain: string;
    resource_type: string;
    license_status: string;
    ai_note: string;
  }> = [];

  for (const node of raw.nodes) {
    const resources = node.resources ?? [];
    const nodeId = nodeIds.find((_, i) => raw.nodes[i].node_id === node.node_id);
    if (!nodeId) continue;
    for (const res of resources) {
      seedResources.push({
        node_id: nodeId,
        external_key: `seed:demo-2026:${node.node_id}:${res.seed_key}`,
        url: res.url,
        title: res.title,
        source_domain: res.source_domain,
        resource_type: res.resource_type,
        license_status: res.license_status,
        ai_note: res.ai_note,
      });
    }
  }

  // Upsert resources using external_key for idempotency
  // embed_allowed=false for demo: external links are sufficient; no iframe embedding needed.
  // content_type_verified=false because no automated verification pipeline ran.
  // status=approved because these are human-curated, pre-approved for the demo.
  for (const res of seedResources) {
    // Domain score lookup retained for potential future use, but embed_allowed is hardcoded false for demo.
    const { data: domainScore } = await supabase
      .from("domain_scores")
      .select("score")
      .eq("domain", res.source_domain)
      .maybeSingle();

    const score = domainScore?.score ?? 2;
    const _embedAllowed = res.license_status === "cc_open" && score >= 4; // computed but not used for demo

    const { error: resError } = await supabase.from("resources").upsert(
      {
        external_key: res.external_key,
        node_id: res.node_id,
        major_understanding_id: null,
        url: res.url,
        title: res.title,
        source_domain: res.source_domain,
        resource_type: res.resource_type,
        license_status: res.license_status,
        embed_allowed: false, // external links only for demo
        content_type_verified: false, // no automated verification pipeline ran
        ai_note: res.ai_note,
        status: "approved", // human-curated, pre-approved for the demo
      },
      { onConflict: "external_key" }
    );

    if (resError) throw resError;
  }

  console.log(`  Seeded ${seedResources.length} curated demo resources.`);

  console.log("Curriculum seed complete.\n");
}

async function seedDomainScores() {
  const raw = JSON.parse(readFileSync(DOMAIN_SCORELIST_PATH, "utf-8"));

  console.log(`Seeding ${raw.domains.length} domain scores...`);

  for (const d of raw.domains) {
    const { error } = await supabase.from("domain_scores").upsert(
      {
        domain: d.domain,
        score: d.score,
        category: d.category,
        notes: d.notes,
      },
      { onConflict: "domain" }
    );

    if (error) throw error;
  }

  console.log("Domain scorelist seed complete.\n");
}

async function main() {
  try {
    await seedCurriculum();
    await seedDomainScores();
    console.log("✅ All seed data loaded successfully.");
  } catch (err) {
    console.error("❌ Seed failed:", err);
    process.exit(1);
  }
}

main();
