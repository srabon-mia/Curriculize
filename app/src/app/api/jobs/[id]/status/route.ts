import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { getJobById } from '@/lib/acquisition/jobService';
import { getStoredCoverageStatus } from '@/lib/acquisition/coverage';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    const job = await getJobById(id);

    if (!job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }

    // Verify ownership
    if (job.created_by !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Build progress info
    const checkpoint = job.result_data?.checkpoint as { completedTopicIds?: string[] } | undefined;
    const topicsCompleted = checkpoint?.completedTopicIds?.length ?? 0;
    const totalTopics = job.input_data?.totalTopics as number ?? 0;
    const resourcesFound = job.result_data?.resourcesFound as number ?? 0;
    const aiCallsUsed = job.result_data?.aiCallsUsed as number ?? 0;
    const coverageAttempts = job.result_data?.resourceCoverage as
      | Record<string, { status?: string }>
      | undefined;
    const coverageStatus = getStoredCoverageStatus({
      jobStatus: job.status,
      coverage: coverageAttempts,
      expectedTargets: totalTopics * 2,
    });

    let step: 'skeleton' | 'sources' | 'discovery' | 'persisting' | 'complete' = 'skeleton';
    if (job.status === 'completed') step = 'complete';
    else if (job.status === 'failed') step = 'complete';
    else if (topicsCompleted > 0) step = 'discovery';
    else if (job.status === 'running') step = 'sources';

    return NextResponse.json({
      id: job.id,
      status: job.status,
      coverage_status: coverageStatus,
      progress: {
        step,
        currentTopic: job.result_data?.lastTopic as string | undefined,
        topicsCompleted,
        totalTopics,
        resourcesFound,
        aiCallsUsed,
      },
      error: job.error,
      startedAt: job.started_at,
      completedAt: job.completed_at,
    });
  } catch (error) {
    console.error('Get job status error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
