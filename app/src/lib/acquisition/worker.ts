/**
 * Phase 9 Durable Worker
 * Core orchestration logic for durable acquisition job processing.
 * Runs within the scheduled processor endpoint.
 */

import {
  claimNextJob,
  renewLease,
  reserveAICall,
  persistWithFence,
  advanceCheckpoint,
  advanceBatchCheckpoint,
  completeJob,
  failJob,
  recoverStaleJobs,
  releaseJobClaim,
  saveJobSources,
  getJobById,
  DEFAULT_BUDGET_LIMITS,
  LEASE_RENEWAL_INTERVAL_MS,
} from '@/lib/acquisition/jobService';
import { acquireCandidate, type AcquisitionResult, DEFAULT_ACQUISITION_OPTIONS } from '@/lib/acquisition/engine';
import { extractEducationalEvidence } from '@/lib/evidence';
import { verifyContent, type VerificationResult } from '@/lib/verification';
import { buildDiscoverPrompt, buildTopicBatchPrompt } from '@/lib/prompts/discover';
import { buildSourceDiscoveryPrompt } from '@/lib/prompts/sources';
import { buildSkeletonPrompt } from '@/lib/prompts/skeleton';
import { getAIProvider } from '@/lib/ai';
import { normalizeResourceType } from '@/lib/acquisition/resourceTypes';
import { getNodesWithUnderstandings, type NodeWithChildren } from '@/lib/curriculum-data';
import { createClient } from '@supabase/supabase-js';
import type { AICompleteResult } from '@/lib/ai/types';
import type { JobBudgetLimits, JobClaimResult } from '@/lib/acquisition/jobTypes';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const MAX_TOPICS_PER_INVOCATION = 2;

class ResourcePersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResourcePersistenceError';
  }
}

/** Fail the job instead of checkpointing a topic whose resource write failed. */
export function requireSuccessfulPersistence(
  result: { error?: string },
  jobId: string,
  topicId: string
): void {
  if (!result.error) return;
  console.error('Persistence error:', { job_id: jobId, topic_id: topicId, error: result.error });
  throw new ResourcePersistenceError(result.error);
}

function getAdminClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
}

function getServiceClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
}

// Lazy AI provider getter
function getAI(operation: string) {
  return getAIProvider(undefined, { operation });
}

/**
 * Call AI provider with web search for curriculum skeleton.
 */
async function callAISkeleton(prompt: string): Promise<string> {
  const textResult: AICompleteResult = await getAI("worker_initial_discovery").complete(prompt, { useSearch: true, maxTokens: 4000 });
  return textResult.text;
}

/**
 * Call AI provider for source discovery (no search).
 */
async function callAISources(prompt: string): Promise<string> {
  const textResult: AICompleteResult = await getAI("worker_source_discovery").complete(prompt, { useSearch: false, maxTokens: 2000 });
  return textResult.text;
}

/**
 * Call AI provider for topic-level resource discovery.
 */
async function callAIDiscover(prompt: string): Promise<string> {
  const textResult: AICompleteResult = await getAI("worker_topic_discovery").complete(prompt, { useSearch: true, maxTokens: 2000 });
  return textResult.text;
}

/**
 * Call AI provider for per-understanding batch discovery.
 */
async function callAITopicBatch(prompt: string): Promise<string> {
  const textResult: AICompleteResult = await getAI("worker_resource_discovery").complete(prompt, { useSearch: true, maxTokens: 2000 });
  return textResult.text;
}

/**
 * Extract JSON from AI response text.
 */
function extractJSON(text: string): unknown {
  let match = text.match(/\[[\s\S]*\]/);
  if (match) {
    try { return JSON.parse(match[0]); } catch {}
  }
  match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed)) return parsed;
      const arrayValue = Object.values(parsed).find(v => Array.isArray(v));
      if (arrayValue) return arrayValue;
      return parsed;
    } catch {}
  }
  throw new Error('No valid JSON found in response');
}

/**
 * Parse curriculum skeleton from AI response.
 */
interface JobResultDataWithCheckpoint {
  checkpoint?: {
    completedTopicIds: string[];
  };
  [key: string]: unknown;
}

interface SkeletonNode {
  title: string;
  order_index: number;
  major_understandings: Array<{ code: string | null; description: string }>;
}

interface Skeleton {
  title: string;
  source_type: string;
  source_attribution: string | null;
  source_url: string | null;
  nodes: SkeletonNode[];
}

function parseSkeleton(text: string): Skeleton | null {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]) as Skeleton;
  } catch {
    return null;
  }
}

/**
 * Parse discovered sources from AI response.
 */
interface DiscoveredSource {
  domain: string;
  name: string;
  why: string;
  best_for: string;
}

function parseSources(text: string): DiscoveredSource[] {
  try {
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [];
    return JSON.parse(match[0]) as DiscoveredSource[];
  } catch {
    return [];
  }
}

/**
 * Parse topic-level resource candidates from AI response.
 */
interface ResourceCandidate {
  url: string;
  title: string;
  resource_type: string;
  source_domain: string;
  ai_note: string;
  license_status: 'cc_open' | 'link_only' | 'unknown_review_needed';
}

function parseCandidates(text: string): ResourceCandidate[] {
  try {
    const parsed = extractJSON(text);
    if (!Array.isArray(parsed)) return [];
    return parsed as ResourceCandidate[];
  } catch {
    return [];
  }
}

/**
 * Parse per-understanding batch resources from AI response.
 */
interface BatchResource {
  url: string;
  title: string;
  resource_type: string;
  source_domain: string;
  ai_note: string;
  license_status: string;
  understanding_codes: string[];
}

function parseBatchResources(text: string): BatchResource[] {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed.topic_resources)) return [];
    return parsed.topic_resources as BatchResource[];
  } catch {
    return [];
  }
}

/**
 * Map AI candidate to DiscoveryCandidate for acquisition pipeline.
 */
function mapToDiscoveryCandidate(candidate: ResourceCandidate, sourceDomains: string[]): {
  url: string;
  title: string;
  sourceDomain: string;
  resourceType: string;
  aiNote: string;
  licenseStatus: 'cc_open' | 'link_only' | 'unknown_review_needed';
} {
  const domain = candidate.source_domain || new URL(candidate.url).hostname;
  return {
    url: candidate.url,
    title: candidate.title,
    sourceDomain: domain,
    resourceType: candidate.resource_type,
    aiNote: candidate.ai_note,
    licenseStatus: candidate.license_status ?? 'link_only',
  };
}

/**
 * Main worker function: process a single job from claim to completion.
 * This is the core durable worker logic.
 */
export async function processJob(job: JobClaimResult): Promise<void> {
  const jobId = job.id;
  const claimToken = job.claim_token;
  const claimVersion = job.claim_version;
  const budgetLimits = job.budget_limits;
  const inputData = job.input_data as Record<string, unknown> | null;
  const curriculumId = job.curriculum_id;
  const maxAiCalls = budgetLimits?.max_ai_calls ?? DEFAULT_BUDGET_LIMITS.max_ai_calls;

  if (!curriculumId) {
    const { failJob } = await import('@/lib/acquisition/jobService');
    await failJob(job.id, job.claim_token!, job.claim_version, 'No curriculum_id on job');
    return;
  }

  // Heartbeat interval
  const heartbeatInterval = setInterval(async () => {
    const { renewLease } = await import('@/lib/acquisition/jobService');
    const renewed = await renewLease(job.id, job.claim_token!);
    if (!renewed) {
      clearInterval(heartbeatInterval);
    }
  }, 60_000); // Every 60 seconds

  try {
    // Step 1: Recover stale jobs before processing
    await recoverStaleJobs();

    // Step 2: Get curriculum and build skeleton
    const supabase = getAdminClient();
    const { data: curriculum } = await supabase
      .from('curricula')
      .select('*')
      .eq('id', curriculumId)
      .single();

    if (!curriculum) {
      const { failJob } = await import('@/lib/acquisition/jobService');
      await failJob(job.id, job.claim_token!, job.claim_version, 'Curriculum not found');
      return;
    }

    const curriculumNotes = curriculum.notes ? JSON.parse(curriculum.notes) as Record<string, unknown> : {};

    // Step 2a: Resume detection - check if nodes already exist from a previous
    // invocation. If they do, we skip skeleton generation to avoid re-spending
    // an AI call and potentially producing a different topic list that would
    // invalidate completedTopicIds checkpoint entries.
    const { data: existingNodes } = await supabase
      .from('nodes')
      .select('*')
      .eq('curriculum_id', curriculumId)
      .order('order_index', { ascending: true });

    const structureExists = (existingNodes?.length ?? 0) > 0;

    // Step 2b: Source discovery caching - reuse persisted sources if available
    // to avoid re-spending the AI call on resume.
    const jobState = await getJobById(job.id);
    const persistedSources = (jobState?.result_data as { discoveredSources?: unknown })?.discoveredSources;
    const cachedSources: DiscoveredSource[] = Array.isArray(persistedSources)
      ? persistedSources.filter(
          (s): s is DiscoveredSource =>
            typeof s === "object" && s !== null && typeof (s as DiscoveredSource).domain === "string"
        )
      : [];

    const nodeIds: Array<{ nodeId: string; node: SkeletonNode }> = [];
    // Title used in discovery prompts. On a fresh run this is the AI-generated
    // skeleton title; on resume it is the title persisted by the earlier run.
    let discoveryTitle = curriculum.title;
    let skeleton: Skeleton | null = null;

    if (structureExists) {
      // Reuse the persisted structure - no AI call, no re-insert.
      const { data: existingMus } = await supabase
        .from('major_understandings')
        .select('id, node_id, code, description, order_index')
        .in('node_id', (existingNodes ?? []).map((n) => n.id));

      for (const node of existingNodes ?? []) {
        const mus = (existingMus ?? [])
          .filter((m) => m.node_id === node.id)
          .sort((a, b) => a.order_index - b.order_index)
          .map((m) => ({
            code: m.code,
            description: m.description,
          }));

        nodeIds.push({
          nodeId: node.id,
          node: {
            title: node.title,
            order_index: node.order_index,
            major_understandings: mus,
          },
        });
      }

      console.log(`[worker] Resuming with ${nodeIds.length} existing topics (skeleton AI call skipped)`);
    } else {
      const skeletonPrompt = buildSkeletonPrompt(
        curriculum.title,
        (curriculumNotes.grade_level as string) ?? 'high school',
        (curriculumNotes.difficulty as string) ?? 'standard',
        (curriculumNotes.existing_knowledge as string) ?? '',
        (curriculumNotes.learning_goal as string) ?? 'understand the subject',
        (curriculumNotes.time_available as string) ?? 'no time pressure',
        (curriculumNotes.added_context as string) ?? ''
      );

      // Reserve AI call for skeleton
      const skeletonReservationId = crypto.randomUUID();
      const skeletonReservation = await reserveAICall(
        job.id, job.claim_token!, job.claim_version,
        maxAiCalls,
        skeletonReservationId
      );

      if (!skeletonReservation.reserved) {
        if (skeletonReservation.reason === 'budget_exhausted') {
          const { completeJob } = await import('@/lib/acquisition/jobService');
          await completeJob(job.id, job.claim_token!, job.claim_version, false);
        }
        return;
      }

      const skeletonText = await callAISkeleton(skeletonPrompt);
      const skeleton = parseSkeleton(skeletonText);
      if (!skeleton) {
        const { failJob } = await import('@/lib/acquisition/jobService');
        await failJob(job.id, job.claim_token!, job.claim_version, 'Failed to parse skeleton');
        return;
      }

      // Update curriculum with skeleton info
      await getAdminClient()
        .from('curricula')
        .update({
          title: skeleton.title,
          source_type: skeleton.source_type,
          source_attribution: skeleton.source_attribution,
          source_url: skeleton.source_url,
        })
        .eq('id', curriculumId);

      discoveryTitle = skeleton.title;

      // Step 3: Insert nodes and major understandings
      for (const node of skeleton.nodes) {
        const topicExternalKey = `topic-${node.order_index}`;
        const { data: nodeRow } = await supabase
          .from('nodes')
          .upsert({
            curriculum_id: curriculumId,
            title: node.title,
            order_index: node.order_index,
            external_key: topicExternalKey,
          }, { onConflict: 'curriculum_id,external_key' })
          .select('id')
          .single();

        if (!nodeRow) continue;

        const mus = node.major_understandings.map((mu: SkeletonNode['major_understandings'][0], i: number) => ({
          node_id: nodeRow.id,
          external_key: mu.code ?? `${node.order_index}.${i + 1}`,
          code: mu.code,
          description: mu.description,
          order_index: i,
        }));

        await supabase
          .from('major_understandings')
          .upsert(mus, { onConflict: 'node_id,external_key' });
        nodeIds.push({ nodeId: nodeRow.id, node });
      }
    }

    // Read checkpoint to skip already-completed topics
    const jobData = await getJobById(job.id);
    const rawCompletedTopics =
      (jobData?.result_data as { checkpoint?: { completedTopicIds: unknown } })?.checkpoint
        ?.completedTopicIds;
    const completedTopics = new Set(
      Array.isArray(rawCompletedTopics)
        ? rawCompletedTopics.filter((id): id is string => typeof id === "string")
        : []
    );

    // Step 4: Source discovery (one-time; cached in result_data for resume)
    let discoveredSources: DiscoveredSource[] = cachedSources;

    if (discoveredSources.length === 0) {
      const sourcesPrompt = buildSourceDiscoveryPrompt(
        curriculum.title,
        (curriculumNotes.difficulty as string) ?? 'standard',
        (curriculumNotes.learning_goal as string) ?? 'understand the subject'
      );

      const sourcesReservationId = crypto.randomUUID();
      const sourcesReservation = await reserveAICall(
        job.id, job.claim_token!, job.claim_version,
        maxAiCalls,
        sourcesReservationId
      );

      if (sourcesReservation.reserved) {
        const sourcesText = await callAISources(sourcesPrompt);
        discoveredSources = parseSources(sourcesText);
        // Persist so a resumed invocation does not re-spend this AI call.
        await saveJobSources(
          job.id, job.claim_token!, job.claim_version, discoveredSources
        );
      }
    } else {
      console.log(`[worker] Reusing ${discoveredSources.length} cached sources (source AI call skipped)`);
    }

    // Step 5: Topic-level resource discovery
    // Bounded work: at most MAX_TOPICS_PER_INVOCATION new topics per invocation.
    // Topics already recorded in the checkpoint are skipped, so a resumed
    // invocation continues from where the previous one stopped.
    let topicsProcessedThisInvocation = 0;

    for (let i = 0; i < nodeIds.length; i++) {
      const { nodeId, node } = nodeIds[i];

      // Skip already-completed topics (resume from checkpoint)
      if (completedTopics.has(nodeId)) {
        console.log(`[worker] Skipping topic ${nodeId} - already completed (checkpoint)`);
        continue;
      }

      // Bounded work: release the claim and yield to the next cron invocation
      // once this invocation's topic quota is exhausted. release_job_claim sets
      // status='pending' without consuming a retry, so the next cron run can
      // claim the job and resume from the checkpoint.
      if (topicsProcessedThisInvocation >= MAX_TOPICS_PER_INVOCATION) {
        console.log(
          `[worker] Topic quota (${MAX_TOPICS_PER_INVOCATION}) reached, releasing claim for next cron run`
        );
        const released = await releaseJobClaim(job.id, job.claim_token!, job.claim_version);
        if (!released) {
          // release failed: claim already lost (stolen by another worker) OR
          // release refused (e.g., yield cap reached). In either case, do not
          // continue — the job will be reclaimed by the cron worker and resume
          // from the checkpoint.
          console.log(
            `[worker] release_job_claim returned false — ownership lost or yield refused; yielding for next cron run`
          );
        }
        return;
      }
      topicsProcessedThisInvocation++;

      // Reserve AI call for topic discovery
      const topicReservationId = crypto.randomUUID();
      const topicReservation = await reserveAICall(
        job.id, job.claim_token!, job.claim_version,
        maxAiCalls,
        topicReservationId
      );

      if (!topicReservation.reserved) {
        if (topicReservation.reason === 'budget_exhausted') {
          const { failJob } = await import('@/lib/acquisition/jobService');
          await failJob(job.id, job.claim_token!, job.claim_version, 'AI budget exhausted: budget_exhausted');
        }
        return;
      }

      // Build topic prompt
      const topicNode: NodeWithChildren = {
        id: nodeId,
        curriculum_id: curriculumId,
        external_key: null,
        title: node.title,
        order_index: node.order_index,
        exam_weight_pct: null,
        claim_statement: null,
        major_understandings: node.major_understandings.map((mu: SkeletonNode['major_understandings'][0], idx: number) => ({
        id: `temp-${node.order_index}-${idx}`,
        node_id: '',
        external_key: mu.code ?? null,
        code: mu.code,
        description: mu.description,
        order_index: idx,
      })),
      };
      const topicPrompt = buildDiscoverPrompt(
        topicNode,
        'topic',
        undefined,
        undefined,
        discoveryTitle,
        discoveredSources.map((s) => s.domain)
      );

      const topicText = await callAIDiscover(topicPrompt);
      const candidates = parseCandidates(topicText);

      // Process candidates through acquisition pipeline
      for (const candidate of candidates) {
        if (!candidate.url || !candidate.title) continue;

        const resourceType = normalizeResourceType(candidate.resource_type);
        const mappedCandidate = mapToDiscoveryCandidate({ ...candidate, resource_type: resourceType }, []);

        // Acquire and process through pipeline (deterministic - no AI call)
        const acquisitionResult = await acquireCandidate(
          { url: mappedCandidate.url, title: mappedCandidate.title, sourceDomain: mappedCandidate.sourceDomain, resourceType: mappedCandidate.resourceType, aiNote: mappedCandidate.aiNote },
          { ...DEFAULT_ACQUISITION_OPTIONS, timeoutMs: 8000 },
        );

        if (!acquisitionResult.success || !acquisitionResult.acquiredPage || !acquisitionResult.structuredContent) {
          continue;
        }

        const { acquiredPage, structuredContent } = acquisitionResult;

        // Extract educational evidence
        let educationalEvidence: ReturnType<typeof extractEducationalEvidence>;
        try {
          educationalEvidence = extractEducationalEvidence(structuredContent);
        } catch {
          continue;
        }

        // Verify content
        let verificationResult: VerificationResult;
        try {
          verificationResult = verifyContent({
            acquiredPage: {
              contentHash: acquiredPage.contentHash,
              canonicalUrl: acquiredPage.canonicalUrl.url,
              finalUrl: acquiredPage.finalUrl,
              statusCode: acquiredPage.statusCode,
              contentType: acquiredPage.contentType,
              acquiredAt: acquiredPage.acquiredAt,
            },
            structuredContent,
            educationalEvidence,
          });
        } catch {
          continue;
        }

        // Persist with fencing
        const persistResult = await persistWithFence(job.id, job.claim_token!, {
          acquiredPage,
          structuredContent: structuredContent,
          educationalEvidence,
          verificationResult,
          target: { nodeId },
          acquisitionJobId: job.id,
          callerMetadata: {
            resourceType: mappedCandidate.resourceType,
            licenseStatus: mappedCandidate.licenseStatus,
            aiNote: candidate.ai_note ?? null,
          },
        });

        requireSuccessfulPersistence(persistResult, job.id, nodeId);
      }

      // Advance checkpoint for this topic.
      // The return value MUST be checked: a false result means the claim was
      // lost (lease expired or claim replaced). Continuing would let a stale
      // worker keep writing under a dead claim, and would attempt to release
      // a claim it no longer owns.
      const checkpointOk = await advanceCheckpoint(
        job.id, job.claim_token!, job.claim_version, nodeId, 0
      );
      if (!checkpointOk) {
        console.error(
          `[worker] advance_checkpoint returned false — ownership lost for job ${job.id}`
        );
        return;
      }
    }

    // Step 6: Background per-understanding batch discovery.
    // Returns false when it yielded (quota exhausted) so we do NOT publish or
    // complete the job — the next cron invocation resumes from the batch
    // checkpoint.
    const batchComplete = await processBatchDiscovery(job, discoveryTitle, nodeIds);

    if (!batchComplete) {
      // Yielded: claim already released inside processBatchDiscovery.
      return;
    }

    // Final completion: only mark the job 'completed' if ALL work succeeded.
    const completeOk = await completeJob(
      job.id,
      job.claim_token!,
      job.claim_version,
      true
    );

    if (!completeOk) {
      // completeJob failed (claim lost or concurrent completion). The job
      // will be recovered or retried by the cron worker. Do NOT publish.
      console.error(
        `[worker] completeJob returned false — job ${job.id} may have been reclaimed; leaving curriculum unpublished`
      );
      return;
    }

    // Job is terminally completed. Now publish the curriculum.
    await supabase
      .from('curricula')
      .update({ status: 'published' })
      .eq('id', curriculumId);

  } catch (error) {
    console.error('Job processing error:', error);
    const { failJob } = await import('@/lib/acquisition/jobService');
    await failJob(job.id, job.claim_token!, job.claim_version, error instanceof Error ? error.message : 'Unknown error');
  } finally {
    clearInterval(heartbeatInterval);
  }
}

/**
 * Process per-understanding batch discovery (background).
 *
 * Bounded: processes at most MAX_TOPICS_PER_INVOCATION new topics per
 * invocation. Progress is tracked in a SEPARATE checkpoint scope
 * ('batchCheckpoint') so batch progress resumes independently of topic-level
 * progress. When the quota is exhausted the claim is released (so the next
 * cron invocation can claim the job) and `false` is returned; the caller must
 * NOT publish or complete the job in that case.
 *
 * Returns true when every topic's batch discovery has completed.
 */
export async function processBatchDiscovery(
  job: JobClaimResult,
  discoveryTitle: string,
  nodeIds: Array<{ nodeId: string; node: SkeletonNode }>
): Promise<boolean> {
  const budgetLimits = job.budget_limits;
  const maxAiCalls = budgetLimits?.max_ai_calls ?? DEFAULT_BUDGET_LIMITS.max_ai_calls;

  const supabase = getAdminClient();
  const { data: curriculumRow } = await supabase
    .from('curricula')
    .select('title')
    .eq('id', job.curriculum_id)
    .single();

  const bgCurriculumTitle = curriculumRow?.title ?? discoveryTitle;

  // Read the batch-phase checkpoint so a resumed invocation skips topics whose
  // batch discovery already completed.
  const batchJobData = await getJobById(job.id);
  const rawCompletedBatchTopics =
    (batchJobData?.result_data as { batchCheckpoint?: { completedTopicIds: unknown } })
      ?.batchCheckpoint?.completedTopicIds;
  const completedBatchTopics = new Set(
    Array.isArray(rawCompletedBatchTopics)
      ? rawCompletedBatchTopics.filter((id): id is string => typeof id === "string")
      : []
  );

  let batchTopicsProcessed = 0;

  for (let i = 0; i < nodeIds.length; i++) {
    const { nodeId, node } = nodeIds[i];

    // Skip topics whose batch discovery already completed (resume).
    if (completedBatchTopics.has(nodeId)) {
      console.log(`[worker] Skipping batch for topic ${nodeId} - already completed (batch checkpoint)`);
      continue;
    }

    const { data: muRows } = await supabase
      .from('major_understandings')
      .select('id, code, description, external_key')
      .eq('node_id', nodeId);

    if (!muRows || muRows.length === 0) continue;

    // Empty topics have no per-understanding discovery work, so do not let
    // them consume the bounded batch quota. Match the stream route's ordering:
    // count only topics that can actually enter batch discovery.
    if (batchTopicsProcessed >= MAX_TOPICS_PER_INVOCATION) {
      console.log(
        `[worker] Batch quota (${MAX_TOPICS_PER_INVOCATION}) reached, releasing claim for next cron run`
      );
      const released = await releaseJobClaim(job.id, job.claim_token!, job.claim_version);
      if (!released) {
        console.log(
          `[worker] release_job_claim returned false — ownership lost or yield refused; yielding for next cron run`
        );
      }
      return false;
    }
    batchTopicsProcessed++;

    // Reserve AI call for batch
    const batchReservationId = crypto.randomUUID();
    const batchReservation = await reserveAICall(
      job.id, job.claim_token, job.claim_version,
      maxAiCalls,
      batchReservationId
    );

    if (!batchReservation.reserved) {
      if (batchReservation.reason === 'budget_exhausted') {
        const { failJob } = await import('@/lib/acquisition/jobService');
        await failJob(job.id, job.claim_token, job.claim_version, 'AI budget exhausted: budget_exhausted');
      }
      return false;
    }

    let batchPersistedCount = 0;

    try {
      const batchNode: NodeWithChildren = {
        id: nodeId,
        curriculum_id: job.curriculum_id!,
        external_key: null,
        title: node.title,
        order_index: node.order_index,
        exam_weight_pct: null,
        claim_statement: null,
        major_understandings: muRows.map((m) => ({
          id: m.id as string,
          node_id: nodeId,
          external_key: m.external_key ?? m.code ?? null,
          code: m.code ?? null,
          description: m.description,
          order_index: 0,
        })),
      };
      const prompt = buildTopicBatchPrompt(
        batchNode,
        bgCurriculumTitle,
        [] // discovered sources
      );

      const text = await callAITopicBatch(prompt);
      const batchResources = parseBatchResources(text);

      for (const candidate of batchResources) {
        if (!candidate.url || !candidate.title) continue;

        const coveredMuIds = muRows
          .filter((mu) =>
            candidate.understanding_codes?.some(
              (code: string) => code === mu.code || code === mu.external_key
            )
          )
          .map((mu) => mu.id as string);

        const targetMuIds = coveredMuIds.length > 0 ? coveredMuIds : muRows.map((m) => m.id as string);

        for (const muId of targetMuIds) {
          const discoveryCandidate = {
            url: candidate.url,
            title: candidate.title,
            sourceDomain: candidate.source_domain || new URL(candidate.url).hostname,
            resourceType: normalizeResourceType(candidate.resource_type),
            aiNote: candidate.ai_note || '',
          };

          const licenseStatus = candidate.license_status === 'cc_open' ? 'cc_open' : 'link_only';
          const resourceType = normalizeResourceType(candidate.resource_type);

          const acquisitionResult = await acquireCandidate(
            { url: discoveryCandidate.url, title: discoveryCandidate.title, sourceDomain: discoveryCandidate.sourceDomain, resourceType, aiNote: discoveryCandidate.aiNote },
            { ...DEFAULT_ACQUISITION_OPTIONS, timeoutMs: 8000 },
          );

          if (!acquisitionResult.success || !acquisitionResult.acquiredPage || !acquisitionResult.structuredContent) continue;

          const { acquiredPage, structuredContent } = acquisitionResult;
          const educationalEvidence = extractEducationalEvidence(structuredContent);
          const verificationResult = verifyContent({
            acquiredPage: {
              contentHash: acquiredPage.contentHash,
              canonicalUrl: acquiredPage.canonicalUrl.url,
              finalUrl: acquiredPage.finalUrl,
              statusCode: acquiredPage.statusCode,
              contentType: acquiredPage.contentType,
              acquiredAt: acquiredPage.acquiredAt,
            },
            structuredContent,
            educationalEvidence,
          });

          const persistResult = await persistWithFence(job.id, job.claim_token, {
            acquiredPage,
            structuredContent,
            educationalEvidence,
            verificationResult,
            target: { understandingId: muId },
            acquisitionJobId: job.id,
            callerMetadata: {
              resourceType,
              licenseStatus,
              aiNote: candidate.ai_note ?? null,
            },
          });
          requireSuccessfulPersistence(persistResult, job.id, nodeId);
          batchPersistedCount++;
        }
      }
    } catch (error) {
      console.error('Batch discovery error:', error);
      if (error instanceof ResourcePersistenceError) throw error;
    }

    // Persist batch progress for this topic. The RPC is fenced by
    // claim_token + claim_version + status='running', so a stale worker
    // cannot overwrite progress recorded by a newer owner.
    const batchCheckpointOk = await advanceBatchCheckpoint(
      job.id, job.claim_token!, job.claim_version, nodeId, batchPersistedCount
    );
    if (!batchCheckpointOk) {
      console.error(
        `[worker] advance_batch_checkpoint returned false — ownership lost for job ${job.id}`
      );
      return false;
    }
  }

  // Every topic's batch discovery has been processed.
  return true;
}

// Re-export functions that need to be imported dynamically
export { persistWithFence, advanceCheckpoint, completeJob, failJob, recoverStaleJobs, getJobById, reserveAICall };
