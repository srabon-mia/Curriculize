import { createClient as createServiceClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

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
    return NextResponse.json({ total: 0, with_resources: 0, complete: true });
  }

  const nodeIds = nodes.map((n) => n.id);

  const { data: mus } = await supabase
    .from("major_understandings")
    .select("id")
    .in("node_id", nodeIds);

  if (!mus || mus.length === 0) {
    return NextResponse.json({ total: 0, with_resources: 0, complete: true });
  }

  const muIds = mus.map((m) => m.id);

  // Count how many MUs have at least one approved resource
  const { data: resources } = await supabase
    .from("resources")
    .select("major_understanding_id")
    .in("major_understanding_id", muIds)
    .eq("status", "approved");

  const withResources = new Set(
    (resources ?? []).map((r) => r.major_understanding_id)
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
  // Generation has finished (failed or completed) but not all MUs have resources
  const generationFinished =
    (jobStatus === "failed" || jobStatus === "completed") &&
    withResources < mus.length;

  return NextResponse.json({
    total: mus.length,
    with_resources: withResources,
    complete: withResources >= mus.length,
    job_status: jobStatus,
    generation_finished: generationFinished,
  });
}