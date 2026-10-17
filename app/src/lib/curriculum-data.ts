import { createClient } from "@/lib/supabase/server";

export type MajorUnderstanding = {
  id: string;
  node_id: string;
  external_key: string | null;
  code: string | null;
  description: string;
  order_index: number;
};

export type Resource = {
  id: string;
  node_id: string | null;
  major_understanding_id: string | null;
  url: string;
  title: string;
  source_domain: string | null;
  resource_type: string;
  license_status: "cc_open" | "link_only" | "unknown_review_needed";
  embed_allowed: boolean;
  ai_note: string | null;
  status: "draft" | "approved" | "rejected";
  created_at: string;
  content_type_verified: boolean;  // Phase 6D: did deterministic verification confirm real content
};

export type NodeWithChildren = {
  id: string;
  curriculum_id: string;
  external_key: string | null;
  title: string;
  order_index: number;
  exam_weight_pct: string | null;
  claim_statement: string | null;
  major_understandings: MajorUnderstanding[];
};

export type Curriculum = {
  id: string;
  title: string;
  subject: string;
  source_type: "adapted" | "ai_organized";
  source_attribution: string | null;
  source_url: string | null;
  status: "draft" | "published" | "archived";
};

export async function getCurricula(): Promise<Curriculum[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("curricula")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) throw new Error(`Failed to load curricula: ${error.message}`);
  return data ?? [];
}

export async function getCurriculum(id: string): Promise<Curriculum | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("curricula")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(`Failed to load curriculum: ${error.message}`);
  return data;
}

export async function getNodesWithUnderstandings(
  curriculumId: string
): Promise<NodeWithChildren[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("nodes")
    .select("*, major_understandings(id, node_id, external_key, code, description, order_index)")
    .eq("curriculum_id", curriculumId)
    .order("order_index", { ascending: true });

  if (error) throw new Error(`Failed to load nodes: ${error.message}`);

  return (data ?? []).map((node) => ({
    ...node,
    major_understandings: [...(node.major_understandings ?? [])].sort(
      (a: MajorUnderstanding, b: MajorUnderstanding) => a.order_index - b.order_index
    ),
  }));
}

export async function getResourcesForTargets(
  nodeIds: string[],
  muIds: string[]
): Promise<Resource[]> {
  const supabase = await createClient();

  const results: Resource[] = [];

  if (nodeIds.length > 0) {
    const { data, error } = await supabase
      .from("resources")
      .select("*")
      .in("node_id", nodeIds);
    if (error) throw new Error(`Failed to load node resources: ${error.message}`);
    results.push(...(data ?? []));
  }

  if (muIds.length > 0) {
    const { data, error } = await supabase
      .from("resources")
      .select("*")
      .in("major_understanding_id", muIds);
    if (error) throw new Error(`Failed to load MU resources: ${error.message}`);
    results.push(...(data ?? []));
  }

  return results;
}

export async function getDomainScores(): Promise<Record<string, number>> {
  const supabase = await createClient();
  const { data } = await supabase.from("domain_scores").select("domain, score");
  const map: Record<string, number> = {};
  for (const row of data ?? []) {
    map[row.domain] = row.score;
  }
  return map;
}

/**
 * Phase 10: Deterministic warm-path resource eligibility.
 *
 * A resource is eligible for student-facing assembly only when BOTH gates pass:
 *   - Publication gate: resources.status = 'approved'  (human-curated / admin-reviewed)
 *   - Verification gate: resources.content_type_verified = true  (Phase 6C deterministic
 *     check passed — the page held real educational content, not SEO filler)
 *
 * These are NOT interchangeable: a resource can be approved-but-unverified
 * (the seed demo rows: approved, content_type_verified=false) or
 * verified-but-draft (AI-acquired pages that haven't been admin-approved yet).
 */
export function selectEligibleResources(resources: Resource[]): Resource[] {
  return resources.filter(
    (r) => r.status === "approved" && r.content_type_verified === true
  );
}

/** Target key for a resource: node or major_understanding. */
export function resourceTargetKey(r: Resource): string | null {
  if (r.node_id) return `node:${r.node_id}`;
  if (r.major_understanding_id) return `mu:${r.major_understanding_id}`;
  return null;
}

/**
 * Rank v1 (architecture §12): domain reputation PRIMARY, then cheapest
 * deterministic tie-breakers, then a stable sort. Resources MUST all be
 * eligible (approved + verified) — the caller is responsible for filtering;
 * ranking never re-checks status.
 *
 * Ordering:
 *   1. domain_score DESC  (from domain_scores table; default 2 for unscored)
 *   2. verification recency DESC (fetched_at from verification_records — passed in
 *      via `fetchedAtByResourceId`; more-recent acquisitions first)
 *   3. stable sort (preserve input order for the ties that remain)
 *
 * `visible_text` length is a documented v1 tie-break but is not stored in the
 * current schema; it is intentionally omitted rather than fetched via AI.
 */
export function rankResourcesV1<T extends Resource>(
  resources: T[],
  domainScores: Record<string, number>,
  fetchedAtByResourceId: Record<string, string | null>
): T[] {
  return [...resources].sort((a, b) => {
    const scoreA = a.source_domain ? domainScores[a.source_domain] ?? 2 : 2;
    const scoreB = b.source_domain ? domainScores[b.source_domain] ?? 2 : 2;
    if (scoreB !== scoreA) return scoreB - scoreA;

    const timeA = fetchedAtByResourceId[a.id] ?? a.created_at;
    const timeB = fetchedAtByResourceId[b.id] ?? b.created_at;
    const cmp = new Date(timeB).getTime() - new Date(timeA).getTime();
    if (cmp !== 0) return cmp;

    return 0; // stable tie
  });
}

/**
 * Deterministic warm-path assembly for a single node's resource list.
 * Reuses selectEligibleResources + rankResourcesV1 so the eligibility gate and
 * ranking are identical everywhere.
 */
export function assembleNodeResources(
  resources: Resource[],
  domainScores: Record<string, number>,
  fetchedAtByResourceId: Record<string, string | null>
): Resource[] {
  return rankResourcesV1(
    selectEligibleResources(resources),
    domainScores,
    fetchedAtByResourceId
  );
}