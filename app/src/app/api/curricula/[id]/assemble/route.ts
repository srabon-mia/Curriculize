import { createClient as createServiceClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import {
  getCurriculum,
  getNodesWithUnderstandings,
  selectEligibleResources,
  rankResourcesV1,
  type Resource,
} from "@/lib/curriculum-data";

const supabase = createServiceClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const curriculum = await getCurriculum(id);
  if (!curriculum || curriculum.status !== "published") {
    return NextResponse.json(
      { error: "Curriculum not found or not published" },
      { status: 404 }
    );
  }

  const nodes = await getNodesWithUnderstandings(id);
  const nodeIds = nodes.map((n) => n.id);
  const muIds = nodes.flatMap((n) => n.major_understandings.map((mu) => mu.id));

  // Fetch ALL resources for this curriculum (draft + approved + rejected).
  // Fetch resources for this curriculum's nodes and major understandings.
  // Two separate queries merged client-side (equivalent to .or() with XOR targets).
  const nodeRes: Resource[] = (nodeIds.length > 0
    ? (await supabase
        .from("resources")
        .select(
          "id, node_id, major_understanding_id, url, title, source_domain, resource_type, license_status, embed_allowed, ai_note, status, content_type_verified, created_at"
        )
        .in("node_id", nodeIds)).data ?? []
    : []);
  const muRes: Resource[] = (muIds.length > 0
    ? (await supabase
        .from("resources")
        .select(
          "id, node_id, major_understanding_id, url, title, source_domain, resource_type, license_status, embed_allowed, ai_note, status, content_type_verified, created_at"
        )
        .in("major_understanding_id", muIds)).data ?? []
    : []);
  // Merge and deduplicate by id (resources have XOR targets so no overlap, but safe).
  const allResources = [...nodeRes, ...muRes].reduce((acc, r) => {
    if (!acc.some((ex) => ex.id === r.id)) acc.push(r);
    return acc;
  }, [] as Resource[]);

  // Fetch domain scores for ranking (primary signal).
  const { data: domainRows, error: dsError } = await supabase
    .from("domain_scores")
    .select("domain, score");

  if (dsError) {
    return NextResponse.json(
      { error: dsError.message },
      { status: 500 }
    );
  }

  const domainScores: Record<string, number> = {};
  for (const row of domainRows ?? []) {
    domainScores[row.domain] = row.score;
  }

  // Fetch verification recency (fetched_at) for the ranking tie-break.
  // Only resources that have a verification record carry a fetched_at.
  const resourceIds = allResources.map((r) => r.id);
  const fetchedAtByResourceId: Record<string, string | null> = {};
  if (resourceIds.length > 0) {
    const { data: vrRows, error: vrError } = await supabase
      .from("verification_records")
      .select("resource_id, fetched_at")
      .in("resource_id", resourceIds);

    if (vrError) {
      return NextResponse.json(
        { error: vrError.message },
        { status: 500 }
      );
    }
    for (const vr of vrRows ?? []) {
      fetchedAtByResourceId[vr.resource_id] = vr.fetched_at;
    }
  }

  // Assemble per-target resource lists: eligible only, ranked v1.
  // Every target (node + MU) is always present in the response, even with
  // zero resources — this lets the frontend render the full topic tree and
  // show an honest "no resources yet" state instead of a missing key.
  const resourcesByTarget: Record<string, Resource[]> = {};
  const candidateResourcesByTarget: Record<string, Resource[]> = {};
  const grouped: Record<string, Resource[]> = {};
  for (const r of allResources) {
    const key =
      r.node_id ? `node:${r.node_id}` : `mu:${r.major_understanding_id}`;
    if (!key) continue;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(r);
  }

  for (const n of nodes) {
    const topicKey = `node:${n.id}`;
    resourcesByTarget[`node:${n.id}`] = rankResourcesV1(
      selectEligibleResources(grouped[`node:${n.id}`] ?? []),
      domainScores,
      fetchedAtByResourceId
    );
    candidateResourcesByTarget[topicKey] = rankResourcesV1(
      (grouped[topicKey] ?? []).filter((resource) => resource.status === "draft"),
      domainScores,
      fetchedAtByResourceId
    );
    for (const mu of n.major_understandings) {
      const muKey = `mu:${mu.id}`;
      resourcesByTarget[`mu:${mu.id}`] = rankResourcesV1(
        selectEligibleResources(grouped[`mu:${mu.id}`] ?? []),
        domainScores,
        fetchedAtByResourceId
      );
      candidateResourcesByTarget[muKey] = rankResourcesV1(
        (grouped[muKey] ?? []).filter((resource) => resource.status === "draft"),
        domainScores,
        fetchedAtByResourceId
      );
    }
  }

  // Honest coverage signal: how many targets have at least one eligible resource.
  const eligibleCount = Object.values(resourcesByTarget).filter(
    (rs) => rs.length > 0
  ).length;

  return NextResponse.json({
    curriculum: {
      id: curriculum.id,
      title: curriculum.title,
      subject: curriculum.subject,
      source_type: curriculum.source_type,
      source_attribution: curriculum.source_attribution,
      source_url: curriculum.source_url,
      status: curriculum.status,
    },
    nodes: nodes.map((n) => ({
      id: n.id,
      curriculum_id: n.curriculum_id,
      external_key: n.external_key,
      title: n.title,
      order_index: n.order_index,
      exam_weight_pct: n.exam_weight_pct,
      claim_statement: n.claim_statement,
      major_understandings: n.major_understandings,
    })),
    resourcesByTarget,
    candidateResourcesByTarget,
    coverage: {
      eligible_targets: eligibleCount,
      total_targets: nodes.reduce(
        (sum, n) => sum + n.major_understandings.length + 1,
        0
      ),
    },
  });
}
