import { createClient as createServiceClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { getCoverageStatus } from "@/lib/acquisition/coverage";

const supabase = createServiceClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Get all MU ids for this curriculum
  const { data: nodes } = await supabase
    .from("nodes")
    .select("id")
    .eq("curriculum_id", id);

  if (!nodes || nodes.length === 0) {
    return NextResponse.json({ total: 0, with_resources: 0, complete: false, coverage_status: "pending" });
  }

  const nodeIds = nodes.map((n) => n.id);

  const { data: mus } = await supabase
    .from("major_understandings")
    .select("id")
    .in("node_id", nodeIds);

  if (!mus || mus.length === 0) {
    return NextResponse.json({ total: 0, with_resources: 0, complete: false, coverage_status: "pending" });
  }

  const muIds = mus.map((m) => m.id);

  // Count how many MUs have at least one approved resource
  const { data: resources, error: resourceQueryError } = await supabase
    .from("resources")
    .select("id, node_id, major_understanding_id")
    .or(`node_id.in.(${nodeIds.join(",")}),major_understanding_id.in.(${muIds.join(",")})`)
    .eq("status", "approved")
    .eq("content_type_verified", true);

  const withResources = new Set(
    (resources ?? []).map((r) => r.major_understanding_id).filter(Boolean)
  ).size;

  // Check the latest generation job for this curriculum
  const { data: job } = await supabase
    .from("acquisition_jobs")
    .select("status")
    .eq("curriculum_id", id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const jobStatus: string | null = job?.status ?? null;
  const eligibleResources = resources ?? [];
  const topicCounts = nodes.map((node) => eligibleResources.filter((r) => r.node_id === node.id).length);
  const understandingCounts = mus.map((mu) => eligibleResources.filter((r) => r.major_understanding_id === mu.id).length);
  const coverageStatus = resourceQueryError
    ? "failed"
    : getCoverageStatus({ jobStatus, topicCounts, understandingCounts });
  const generationFinished = jobStatus === "failed" || jobStatus === "completed";

  return NextResponse.json({
    total: mus.length,
    with_resources: withResources,
    complete: coverageStatus === "complete",
    job_status: jobStatus,
    generation_finished: generationFinished,
    coverage_status: coverageStatus,
    topics: nodes.map((node, index) => ({ id: node.id, resource_count: topicCounts[index], sufficient: topicCounts[index] >= 3 })),
    understandings: mus.map((mu, index) => ({ id: mu.id, resource_count: understandingCounts[index], sufficient: understandingCounts[index] >= 2 })),
  });
}
