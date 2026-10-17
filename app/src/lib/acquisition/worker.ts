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
  completeJob,
  failJob,
  recoverStaleJobs,
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
import { getNodesWithUnderstandings, type NodeWithChildren } from '@/lib/curriculum-data';
import { createClient } from '@supabase/supabase-js';
import type { AICompleteResult } from '@/lib/ai/types';
import type { JobBudgetLimits, JobClaimResult } from '@/lib/acquisition/jobTypes';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

function getAdminClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
}

function getServiceClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
}

// Lazy AI provider getter
function getAI() {
  return getAIProvider();
}

/**
 * Call AI provider with web search for curriculum skeleton.
 */
async function callAISkeleton(prompt: string): Promise<string> {
  const textResult: AICompleteResult = await getAI().complete(prompt, { useSearch: true, maxTokens: 4000 });
  return textResult.text;
}

/**
 * Call AI provider for source discovery (no search).
 */
async function callAISources(prompt: string): Promise<string> {
  const textResult: AICompleteResult = await getAI().complete(prompt, { useSearch: false, maxTokens: 2000 });
  return textResult.text;
}

/**
 * Call AI provider for topic-level resource discovery.
 */
async function callAIDiscover(prompt: string): Promise<string> {
  const textResult: AICompleteResult = await getAI().complete(prompt, { useSearch: true, maxTokens: 2000 });
  return textResult.text;
}

/**
 * Call AI provider for per-understanding batch discovery.
 */
async function callAITopicBatch(prompt: string): Promise<string> {
  const textResult: AICompleteResult = await getAI().complete(prompt, { useSearch: true, maxTokens: 2000 });
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

    // Advance checkpoint: skeleton complete
    await advanceCheckpoint(job.id, job.claim_token!, job.claim_version, 'skeleton', 0);

    // Step 3: Insert nodes and major understandings
    interface SkeletonNode {
      title: string;
      order_index: number;
      major_understandings: Array<{ code: string | null; description: string }>;
    }

    const nodeIds: Array<{ nodeId: string; node: SkeletonNode }> = [];

    for (const node of skeleton.nodes) {
      const { data: nodeRow } = await supabase
        .from('nodes')
        .insert({
          curriculum_id: curriculumId,
          title: node.title,
          order_index: node.order_index,
        })
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

      await supabase.from('major_understandings').insert(mus);
      nodeIds.push({ nodeId: nodeRow.id, node });
    }

    // Advance checkpoint: nodes inserted
    await advanceCheckpoint(job.id, job.claim_token!, job.claim_version, 'nodes', 0);

    // Step 4: Source discovery
    const sourcesPrompt = buildSourceDiscoveryPrompt(
      skeleton.title,
      (curriculumNotes.difficulty as string) ?? 'standard',
      (curriculumNotes.learning_goal as string) ?? 'understand the subject'
    );

    const sourcesReservationId = crypto.randomUUID();
    const sourcesReservation = await reserveAICall(
      job.id, job.claim_token!, job.claim_version,
      maxAiCalls,
      sourcesReservationId
    );

    let discoveredSources: any[] = [];
    if (sourcesReservation.reserved) {
      const sourcesText = await callAISources(sourcesPrompt);
      discoveredSources = parseSources(sourcesText);
    }

    // Advance checkpoint: sources discovered
    await advanceCheckpoint(job.id, job.claim_token!, job.claim_version, 'sources', 0);

    // Step 4: Topic-level resource discovery
    for (let i = 0; i < nodeIds.length; i++) {
      const { nodeId, node } = nodeIds[i];

      // Reserve AI call for topic discovery
      const topicReservationId = crypto.randomUUID();
      const topicReservation = await reserveAICall(
        job.id, job.claim_token!, job.claim_version,
        maxAiCalls,
        topicReservationId
      );

      if (!topicReservation.reserved) {
        if (topicReservation.reason === 'budget_exhausted') {
          const { getJobById, completeJob } = await import('@/lib/acquisition/jobService');
          const jobData = await getJobById(job.id);
          const hasProgress = ((jobData?.result_data as { checkpoint?: { completedTopicIds: string[] } })?.checkpoint?.completedTopicIds?.length ?? 0) > 0;
          await completeJob(job.id, job.claim_token!, job.claim_version, hasProgress);
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
        major_understandings: node.major_understandings.map((mu: any, idx: number) => ({
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
        skeleton.title,
        discoveredSources
      );

      const topicText = await callAIDiscover(topicPrompt);
      const candidates = parseCandidates(topicText);

      // Process candidates through acquisition pipeline
      const validTypes = ['video', 'text', 'textbook', 'problem_set', 'reference_tool', 'practice_exam', 'other'];

      for (const candidate of candidates) {
        if (!candidate.url || !candidate.title) continue;

        const resourceType = ['video', 'text', 'textbook', 'problem_set', 'reference_tool', 'practice_exam', 'other'].includes(candidate.resource_type)
          ? candidate.resource_type : 'other';
        const mappedCandidate = mapToDiscoveryCandidate(candidate, []);

        // Reserve AI call for acquisition (each candidate needs AI for verification)
        const acquisitionReservationId = crypto.randomUUID();
        const acquisitionReservation = await reserveAICall(
          job.id, job.claim_token!, job.claim_version,
          maxAiCalls,
          acquisitionReservationId
        );

        if (!acquisitionReservation.reserved) {
          if (acquisitionReservation.reason === 'budget_exhausted') {
            const { getJobById, completeJob } = await import('@/lib/acquisition/jobService');
            const jobData = await getJobById(job.id);
            const hasProgress = ((jobData?.result_data as { checkpoint?: { completedTopicIds: string[] } })?.checkpoint?.completedTopicIds?.length ?? 0) > 0;
            await completeJob(job.id, job.claim_token!, job.claim_version, hasProgress);
          }
          return;
        }

        // Acquire and process through pipeline
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

        if (persistResult.error) {
          console.error('Persistence error:', persistResult.error);
        }
      }

      // Advance checkpoint for this topic
      await advanceCheckpoint(job.id, job.claim_token!, job.claim_version, nodeId, 0);
    }

    // Step 5: Background per-understanding batch discovery
    await processBatchDiscovery(job, skeleton, nodeIds);

    // Final completion
    await completeJob(job.id, job.claim_token!, job.claim_version, true);

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
 */
async function processBatchDiscovery(
  job: JobClaimResult,
  skeleton: Skeleton,
  nodeIds: Array<{ nodeId: string; node: SkeletonNode }>
): Promise<void> {
  const budgetLimits = job.budget_limits;
  const maxAiCalls = budgetLimits?.max_ai_calls ?? DEFAULT_BUDGET_LIMITS.max_ai_calls;

  const supabase = getAdminClient();
  const { data: curriculumRow } = await supabase
    .from('curricula')
    .select('title')
    .eq('id', job.curriculum_id)
    .single();

  const bgCurriculumTitle = curriculumRow?.title ?? skeleton.title;

  for (let i = 0; i < nodeIds.length; i++) {
    const { nodeId, node } = nodeIds[i];

    const { data: muRows } = await supabase
      .from('major_understandings')
      .select('id, code, description, external_key')
      .eq('node_id', nodeId);

    if (!muRows || muRows.length === 0) continue;

    // Reserve AI call for batch
    const batchReservationId = crypto.randomUUID();
    const batchReservation = await reserveAICall(
      job.id, job.claim_token, job.claim_version,
      maxAiCalls,
      batchReservationId
    );

    if (!batchReservation.reserved) {
      if (batchReservation.reason === 'budget_exhausted') {
        const { getJobById, completeJob } = await import('@/lib/acquisition/jobService');
        const jobData = await getJobById(job.id);
        const hasProgress = ((jobData?.result_data as { checkpoint?: { completedTopicIds: string[] } })?.checkpoint?.completedTopicIds?.length ?? 0) > 0;
        await completeJob(job.id, job.claim_token, job.claim_version, hasProgress);
      }
      return;
    }

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
            resourceType: candidate.resource_type || 'other',
            aiNote: candidate.ai_note || '',
          };

          const licenseStatus = candidate.license_status === 'cc_open' ? 'cc_open' : 'link_only';
          const resourceType = candidate.resource_type || 'other';

          const acquisitionReservationId = crypto.randomUUID();
          const acquisitionReservation = await reserveAICall(
            job.id, job.claim_token, job.claim_version,
            maxAiCalls,
            acquisitionReservationId
          );

          if (!acquisitionReservation.reserved) continue;

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

          await persistWithFence(job.id, job.claim_token, {
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
        }
      }
    } catch (error) {
      console.error('Batch discovery error:', error);
    }

    if (i < nodeIds.length - 1) {
      await new Promise(r => setTimeout(r, 15000));
    }
  }
}

// Re-export functions that need to be imported dynamically
export { persistWithFence, advanceCheckpoint, completeJob, failJob, recoverStaleJobs, getJobById, reserveAICall };