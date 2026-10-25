import { NextResponse } from 'next/server';
import { claimNextJob, recoverStaleJobs } from '@/lib/acquisition/jobService';
import { processJob } from '@/lib/acquisition/worker';
import { createWorkerDeadline } from '@/lib/acquisition/workerDeadline';

// Platform ceiling; worker yields itself well before this to leave room for
// fenced persistence, claim release, and the processor response.
export const maxDuration = 300;

export async function POST(request: Request) {
  let deadline: ReturnType<typeof createWorkerDeadline> | undefined;
  try {
    // Fail closed if configuration is missing and accept only the documented
    // single-token Bearer form. Never include the configured value in logs.
    const configuredSecret = process.env.CRON_SECRET;
    const authorization = request.headers.get('Authorization');
    const bearerMatch = authorization?.match(/^Bearer ([^\s]+)$/);
    if (!configuredSecret || !bearerMatch || bearerMatch[1] !== configuredSecret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Bound the full cron invocation, including stale recovery and claiming.
    deadline = createWorkerDeadline();

    // Every database request uses the same deadline signal. Supabase's
    // PostgREST builder aborts the client request; we do not race a promise
    // and pretend the underlying operation was cancelled.
    try {
      await recoverStaleJobs(deadline.signal);
    } catch (error) {
      if (deadline.signal.aborted) {
        return NextResponse.json({ processed: 0, status: 'yielded', phase: 'recovery' }, { status: 202 });
      }
      console.error('[jobs/process] Stale-job recovery failed', {
        operation: 'recover_stale_jobs',
        error_name: error instanceof Error ? error.name : 'UnknownError',
      });
      return NextResponse.json({ error: 'Stale-job recovery temporarily unavailable' }, { status: 503 });
    }

    // Claim and process jobs (one per invocation to stay within timeout)
    let job;
    try {
      job = await claimNextJob('curriculum_generation', undefined, deadline.signal);
    } catch (error) {
      if (deadline.signal.aborted) {
        // The remote claim may have committed before the client abort reached
        // PostgREST. Its lease/fence prevents a second owner; stale recovery
        // will reclaim it after expiry if no token was returned to this route.
        return NextResponse.json({ processed: 0, status: 'yielded', phase: 'claim_outcome_unknown' }, { status: 202 });
      }
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

    // The worker uses the same deadline and fenced checkpoint/release path.
    const outcome = await processJob(job, deadline);

    if (outcome === 'yielded') {
      return NextResponse.json({ processed: 1, jobId: job.id, status: 'yielded', message: 'Job saved for the next processor invocation' }, { status: 202 });
    }
    if (outcome === 'ownership_lost') {
      return NextResponse.json({ processed: 0, jobId: job.id, status: 'ownership_lost', message: 'The claim could not be confirmed; durable lease recovery will resume the job' }, { status: 202 });
    }

    return NextResponse.json({ processed: 1, jobId: job.id, status: outcome });
  } catch (error) {
    console.error('Job processor error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  } finally {
    deadline?.dispose();
  }
}
