import { createClient as createServiceClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { notesMatchRequest } from "@/lib/curriculum/finder";

const supabase = createServiceClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(request: Request) {
  const body = await request.json();

  const { topic, grade_level, difficulty, existing_knowledge, learning_goal, time_available, added_context } = body;

  if (!topic) {
    return NextResponse.json({ error: "topic is required" }, { status: 400 });
  }

  // Warm-path cache — serve an existing published curriculum for an identical
  // student request, skipping AI generation entirely. Lookup is EXACT on two
  // signals (no fuzzy substring matching across topics):
  //   1. title === topic (case-insensitive; precise, NOT `%topic%`). The prior
  //      `%normalized%` ilike could return the wrong curriculum (e.g. "Chemistry"
  //      matching "Organic Chemistry").
  //   2. curricula.notes (the 6 generate-form fields persisted as JSON at
  //      creation time) === the request's fields. `topic` is intentionally not
  //      in notes — it is matched via (1). Different student inputs never match.
  //
  // No schema change required: `title` and the text `notes` column already capture
  // every GenerateForm field, so an identical re-submission reproduces byte-identical JSON.
  const { data: publishedMatches, error: cacheError } = await supabase
    .from("curricula")
    .select("id, notes")
    .eq("status", "published")
    .ilike("title", topic.trim())
    .order("created_at", { ascending: false });

  // Fail open: a transient cache-lookup failure must not block generation.
  if (!cacheError && publishedMatches) {
    for (const row of publishedMatches) {
      if (
        notesMatchRequest(row.notes, {
          grade_level,
          difficulty,
          existing_knowledge,
          learning_goal,
          time_available,
          added_context,
        })
      ) {
        return NextResponse.json({ curriculum_id: row.id, cached: true });
      }
    }
  }

  // Cold path: create a draft curriculum (no acquisition_jobs row here).
  // The curriculum is created with created_by=NULL to support unauthenticated
  // (guest) generation. The SSE stream registers or observes one durable job,
  // then releases any claim it acquired. /api/jobs/process is the only path
  // that performs generation work, with lease fencing and checkpoint recovery.
  // No job_id is returned because the stream resolves the durable job by
  // curriculum id and reports its saved state via SSE.
  const { data: draft, error: insertError } = await supabase
    .from("curricula")
    .insert({
      title: topic.trim(),
      subject: topic.trim(),
      source_type: "ai_organized",
      status: "draft",
      notes: JSON.stringify({
        grade_level,
        difficulty,
        existing_knowledge,
        learning_goal,
        time_available,
        added_context,
      }),
    })
    .select("id")
    .single();

  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  // Return without a job_id — the SSE stream claims/creates the job at stream
  // start. Frontend navigates to /generate/${id}, which opens the SSE stream
  // and triggers job registration + pipeline execution.
  return NextResponse.json({
    curriculum_id: draft.id,
    cached: false,
  });
}
