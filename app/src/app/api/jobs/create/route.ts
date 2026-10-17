import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { createJobAndCurriculum } from '@/lib/acquisition/jobService';

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { topic, grade_level, difficulty, existing_knowledge, learning_goal, time_available, added_context } = body;

    if (!topic) {
      return NextResponse.json({ error: 'topic is required' }, { status: 400 });
    }

    const result = await createJobAndCurriculum(user.id, {
      topic,
      grade_level: grade_level ?? 'high school',
      difficulty: difficulty ?? 'standard',
      existing_knowledge: existing_knowledge ?? '',
      learning_goal: learning_goal ?? 'understand the subject',
      time_available: time_available ?? 'no time pressure',
      added_context: added_context ?? '',
    });

    if (result.error) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    return NextResponse.json({
      curriculum_id: result.curriculum_id,
      job_id: result.job_id,
    });
  } catch (error) {
    console.error('Create job error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}