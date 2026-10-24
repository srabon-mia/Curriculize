import { NextResponse } from 'next/server';
import { claimNextJob, recoverStaleJobs } from '@/lib/acquisition/jobService';
import { processJob } from '@/lib/acquisition/worker';

// Match the stream route: 300s max duration (requires Vercel Pro).
// cron-job.org must be configured with a timeout > 300s.
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    // Validate CRON_SECRET
    const cronSecret = request.headers.get('Authorization')?.replace('Bearer ', '');
    if (cronSecret !== process.env.CRON_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Recover stale jobs first
    await recoverStaleJobs();

    // Claim and process jobs (one per invocation to stay within timeout)
    let job;
    try {
      job = await claimNextJob('curriculum_generation');
    } catch (error) {
      // Do not report a database/RPC failure as an empty queue. Log only safe
      // operation metadata; RPC error details are intentionally not exposed.
      console.error('[jobs/process] Job claim failed', {
        operation: 'claim_next_job',
        error_name: error instanceof Error ? error.name : 'UnknownError',
      });
      return NextResponse.json({ error: 'Job claim temporarily unavailable' }, { status: 503 });
    }

    if (!job) {
      return NextResponse.json({ processed: 0, message: 'No pending jobs' });
    }

    // Process the job (this will run until completion or timeout)
    await processJob(job);

    return NextResponse.json({ processed: 1, jobId: job.id });
  } catch (error) {
    console.error('Job processor error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
