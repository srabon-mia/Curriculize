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

  // Cold path: create a draft curriculum + a pending acquisition job so the
  // student can receive progress via the SSE stream and /api/jobs/[id]/status.
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

  // Create a pending acquisition job directly via the service client.
  // This inserts a row into acquisition_jobs with status='pending' and links
  // it to the newly-created curriculum. The cron worker (POST /api/jobs/process)
  // will claim and run the full acquisition pipeline. Direct insert is used
  // rather than the create_curriculum_and_job RPC because that RPC requires a
  // valid authenticated user ID (via _validate_owner), and the generate route
  // is intentionally unauthenticated.
  const { data: job, error: jobError } = await supabase
    .from("acquisition_jobs")
    .insert({
      curriculum_id: draft.id,
      job_type: "curriculum_generation",
      status: "pending",
      input_data: JSON.stringify({
        topic: topic.trim(),
        grade_level,
        difficulty,
        existing_knowledge,
        learning_goal,
        time_available,
        added_context,
      }),
      budget_limits: JSON.stringify({
        max_ai_calls: 12,
        max_total_candidates_per_job: 50,
        max_candidates_per_understanding: 5,
        max_fetch_attempts: 3,
        max_retries: 3,
      }),
    })
    .select("id")
    .single();

  if (jobError) {
    console.error("Failed to create acquisition job:", jobError);
    // If job creation fails, proceed without a job — the SSE stream will
    // run inline (current behavior).
    return NextResponse.json({ curriculum_id: draft.id, cached: false });
  }

  return NextResponse.json({
    curriculum_id: draft.id,
    cached: false,
    job_id: job.id
  });
}