import { NextResponse } from 'next/server';
import { claimNextJob, recoverStaleJobs } from '@/lib/acquisition/jobService';
import { processJob } from '@/lib/acquisition/worker';

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
    const job = await claimNextJob('curriculum_generation');

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