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
  recordResourceCoverageAttempt,
  completeJob,
  publishAndCompleteJob,
  failJob,
  recoverStaleJobs,
  releaseJobClaim,
  saveJobSources,
  saveJobSkeleton,
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
import { mapUnderstandingCodesToIds } from '@/lib/acquisition/coverage';
import { runBoundedCoverageAttempts } from '@/lib/acquisition/coverage';
import { createWorkerDeadline, WorkerYieldRequested } from '@/lib/acquisition/workerDeadline';
import { withAbortSignal } from '@/lib/acquisition/abortableRequest';
import { createHash } from 'node:crypto';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const MAX_TOPICS_PER_INVOCATION = 2;
const MAX_COVERAGE_ATTEMPTS = 2;

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

/** Stable UUIDs make a resumed discovery reuse its durable AI reservation. */
export function stableAttemptUuid(...parts: string[]): string {
  const bytes = createHash('sha256').update(parts.join(':')).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function storedCoverageAttempts(resultData: unknown, phase: 'topic' | 'batch', targetId: string): number {
  if (!resultData || typeof resultData !== 'object') return 0;
  const coverage = (resultData as Record<string, unknown>).resourceCoverage;
  if (!coverage || typeof coverage !== 'object') return 0;
  const record = (coverage as Record<string, unknown>)[`${phase}:${targetId}`];
  if (!record || typeof record !== 'object') return 0;
  const attempts = (record as Record<string, unknown>).attempts;
  return Number.isSafeInteger(attempts) && (attempts as number) >= 0 ? attempts as number : 0;
}

export async function materializeSkeletonRows(
  supabase: ReturnType<typeof getAdminClient>,
  curriculumId: string,
  skeleton: Skeleton,
  checkDeadline: () => void = () => undefined,
  signal?: AbortSignal
): Promise<Array<{ nodeId: string; node: SkeletonNode }>> {
  checkDeadline();
  const { error: curriculumUpdateError } = await withAbortSignal(supabase.from('curricula').update({
    title: skeleton.title,
    source_type: skeleton.source_type,
    source_attribution: skeleton.source_attribution,
    source_url: skeleton.source_url,
  }).eq('id', curriculumId), signal);
  if (curriculumUpdateError) throw new Error(`Failed to save curriculum skeleton metadata: ${curriculumUpdateError.message}`);

  // Re-materialize in two bulk writes. The immutable skeleton is already fenced
  // and durable, so a yield between these statements is repaired on resume. A
  // per-node/per-understanding request loop consumed most of the 18s invocation
  // budget before the independently persisted source-discovery step could start.
  checkDeadline();
  const expectedNodes = skeleton.nodes.map((node) => ({
    curriculum_id: curriculumId,
    title: node.title,
    order_index: node.order_index,
    external_key: `topic-${node.order_index}`,
  }));
  const { data: savedNodes, error: nodesError } = await withAbortSignal(supabase.from('nodes')
    .upsert(expectedNodes, { onConflict: 'curriculum_id,external_key' })
    .select('id, external_key'), signal);
  if (nodesError || !savedNodes) throw new Error(`Failed to materialize topics: ${nodesError?.message ?? 'rows missing'}`);
  const nodeByKey = new Map(savedNodes.map((row) => [row.external_key, row]));
  if (nodeByKey.size !== skeleton.nodes.length) throw new Error('Skeleton materialization incomplete: topic rows missing');

  const mus = skeleton.nodes.flatMap((node) => {
    const nodeRow = nodeByKey.get(`topic-${node.order_index}`);
    if (!nodeRow) throw new Error(`Failed to materialize topic-${node.order_index}: row missing`);
    return node.major_understandings.map((mu, i) => ({
      node_id: nodeRow.id,
      external_key: mu.code ?? `${node.order_index}.${i + 1}`,
      code: mu.code,
      description: mu.description,
      order_index: i,
    }));
  });
  checkDeadline();
  const { error: musError } = await withAbortSignal(supabase.from('major_understandings')
    .upsert(mus, { onConflict: 'node_id,external_key' }), signal);
  if (musError) throw new Error(`Failed to materialize understandings: ${musError.message}`);

  checkDeadline();
  const { data: materializedNodes, error: verifyNodesError } = await withAbortSignal(supabase.from('nodes')
    .select('id, external_key, title, order_index').eq('curriculum_id', curriculumId), signal);
  if (verifyNodesError) throw new Error(`Failed to verify topics: ${verifyNodesError.message}`);
  if ((materializedNodes ?? []).length !== skeleton.nodes.length) throw new Error('Skeleton materialization incomplete: topic rows missing');
  const verifiedNodeByKey = new Map((materializedNodes ?? []).map((row) => [row.external_key, row]));
  const nodeIdsForQuery = (materializedNodes ?? []).map((row) => row.id);
  const { data: materializedMus, error: verifyMusError } = await withAbortSignal(supabase.from('major_understandings')
    .select('id, node_id, external_key, code, description, order_index').in('node_id', nodeIdsForQuery), signal);
  if (verifyMusError) throw new Error(`Failed to verify understandings: ${verifyMusError.message}`);
  for (const expectedNode of skeleton.nodes) {
    const row = verifiedNodeByKey.get(`topic-${expectedNode.order_index}`);
    if (!row || row.title !== expectedNode.title || row.order_index !== expectedNode.order_index) {
      throw new Error(`Skeleton materialization mismatch for topic-${expectedNode.order_index}`);
    }
    const actualMus = (materializedMus ?? []).filter((mu) => mu.node_id === row.id);
    if (actualMus.length !== expectedNode.major_understandings.length) {
      throw new Error(`Skeleton materialization incomplete for topic-${expectedNode.order_index} understandings`);
    }
    for (let i = 0; i < expectedNode.major_understandings.length; i++) {
      const expected = expectedNode.major_understandings[i];
      const externalKey = expected.code ?? `${expectedNode.order_index}.${i + 1}`;
      const actual = actualMus.find((mu) => mu.external_key === externalKey);
      if (!actual || actual.code !== expected.code || actual.description !== expected.description || actual.order_index !== i) {
        throw new Error(`Skeleton materialization mismatch for understanding ${externalKey}`);
      }
    }
  }
  return skeleton.nodes.map((node) => ({
    nodeId: verifiedNodeByKey.get(`topic-${node.order_index}`)!.id,
    node,
  }));
}

export async function saveSkeletonBeforeMaterialization<T>(
  save: () => Promise<'saved' | 'already_saved' | 'ownership_lost'>,
  materialize: () => Promise<T>
): Promise<{ status: 'ownership_lost' } | { status: 'materialized'; result: T }> {
  const status = await save();
  if (status === 'ownership_lost') return { status };
  return { status: 'materialized', result: await materialize() };
}

// Lazy AI provider getter
function getAI(operation: string) {
  return getAIProvider(undefined, { operation });
}

/**
 * Call AI provider with web search for curriculum skeleton.
 */
async function callAISkeleton(prompt: string, signal: AbortSignal): Promise<string> {
  const textResult: AICompleteResult = await getAI("worker_initial_discovery").complete(prompt, { useSearch: true, maxTokens: 4000, signal });
  return textResult.text;
}

/**
 * Call AI provider for source discovery (no search).
 */
async function callAISources(prompt: string, signal: AbortSignal): Promise<string> {
  const textResult: AICompleteResult = await getAI("worker_source_discovery").complete(prompt, { useSearch: false, maxTokens: 2000, signal });
  return textResult.text;
}

/**
 * Call AI provider for topic-level resource discovery.
 */
export async function callAIDiscover(
  prompt: string,
  diagnostics: {
    curriculumId: string;
    jobId: string;
    topicId: string;
  },
  signal?: AbortSignal
): Promise<string> {
  const textResult: AICompleteResult = await getAI("worker_topic_discovery").complete(prompt, {
    useSearch: true,
    maxTokens: 2000,
    diagnostics: {
      curriculumId: diagnostics.curriculumId,
      jobId: diagnostics.jobId,
      topicId: diagnostics.topicId,
      operation: 'worker_topic_discovery',
    },
    signal,
  });
  return textResult.text;
}

/**
 * Call AI provider for per-understanding batch discovery.
 */
async function callAITopicBatch(prompt: string, signal?: AbortSignal): Promise<string> {
  // This response contains candidates for every understanding in a topic.
  // 2,000 tokens can truncate the requested 2-per-understanding list; a
  // larger response cap adds no extra AI call and is still bounded.
  const textResult: AICompleteResult = await getAI("worker_resource_discovery").complete(prompt, { useSearch: true, maxTokens: 4000, signal });
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
    const value = JSON.parse(match[0]) as Partial<Skeleton>;
    if (typeof value.title !== 'string' || !value.title.trim() ||
        (value.source_type !== 'adapted' && value.source_type !== 'ai_organized') ||
        !Array.isArray(value.nodes) || value.nodes.length === 0 ||
        !(value.source_attribution === null || typeof value.source_attribution === 'string') ||
        !(value.source_url === null || typeof value.source_url === 'string')) return null;
    const orders = new Set<number>();
    for (const node of value.nodes) {
      if (!node || typeof node.title !== 'string' || !node.title.trim() ||
          !Number.isSafeInteger(node.order_index) || node.order_index < 0 || orders.has(node.order_index) ||
          !Array.isArray(node.major_understandings) || node.major_understandings.length === 0) return null;
      orders.add(node.order_index);
      const externalKeys = new Set<string>();
      for (let i = 0; i < node.major_understandings.length; i++) {
        const mu = node.major_understandings[i];
        if (!mu || typeof mu.description !== 'string' || !mu.description.trim() ||
            !(mu.code === null || (typeof mu.code === 'string' && mu.code.trim()))) return null;
        const key = mu.code ?? `${node.order_index}.${i + 1}`;
        if (externalKeys.has(key)) return null;
        externalKeys.add(key);
      }
    }
    return value as Skeleton;
  } catch {
    return null;
  }
}

function parseStoredSkeleton(value: unknown): Skeleton | null {
  if (!value || typeof value !== 'object') return null;
  return parseSkeleton(JSON.stringify(value));
}

export function classifySkeletonCheckpoint(value: unknown, existingTopicCount: number):
  | { status: 'not_generated' }
  | { status: 'persisted'; skeleton: Skeleton }
  | { status: 'legacy_ambiguous' }
  | { status: 'invalid_checkpoint' } {
  if (value === undefined) return existingTopicCount > 0 ? { status: 'legacy_ambiguous' } : { status: 'not_generated' };
  const skeleton = parseStoredSkeleton(value);
  return skeleton ? { status: 'persisted', skeleton } : { status: 'invalid_checkpoint' };
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

export interface TopicDiscoveryMetrics {
  responseTextChars: number;
  parsedCandidates: number;
  rejectedUrlOrTitle: number;
  fetchFailures: number;
  contentExtractionFailures: number;
  interstitialPageFailures: number;
  verificationRejections: number;
  persistenceSuccesses: number;
  persistenceFailures: number;
  eligibleAssociations: number | null;
}

export function createTopicDiscoveryMetrics(): TopicDiscoveryMetrics {
  return {
    responseTextChars: 0,
    parsedCandidates: 0,
    rejectedUrlOrTitle: 0,
    fetchFailures: 0,
    contentExtractionFailures: 0,
    interstitialPageFailures: 0,
    verificationRejections: 0,
    persistenceSuccesses: 0,
    persistenceFailures: 0,
    eligibleAssociations: null,
  };
}

export function logTopicDiscoveryMetrics(topicId: string, metrics: TopicDiscoveryMetrics): void {
  console.info('[worker] Topic candidate processing summary', {
    topic_id: topicId,
    response_text_chars: metrics.responseTextChars,
    parsed_candidates: metrics.parsedCandidates,
    rejected_url_or_title: metrics.rejectedUrlOrTitle,
    fetch_failures: metrics.fetchFailures,
    content_extraction_failures: metrics.contentExtractionFailures,
    interstitial_page_failures: metrics.interstitialPageFailures,
    verification_rejections: metrics.verificationRejections,
    persistence_successes: metrics.persistenceSuccesses,
    persistence_failures: metrics.persistenceFailures,
    final_eligible_associations: metrics.eligibleAssociations,
  });
}

const URL_VALIDATION_FAILURES = new Set([
  'INVALID_URL', 'BLOCKED_URL', 'DNS_RESOLUTION_FAILED', 'BLOCKED_RESOLVED_IP', 'UNSAFE_REDIRECT',
]);

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
export interface BatchResource {
  url: string;
  title: string;
  resource_type: string;
  source_domain: string;
  ai_note: string;
  license_status: string;
  understanding_codes: string[];
}

function normalizeBatchResource(value: unknown): BatchResource | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.url !== "string" || !candidate.url.trim() ||
      typeof candidate.title !== "string" || !candidate.title.trim() ||
      !Array.isArray(candidate.understanding_codes) || candidate.understanding_codes.length === 0 ||
      !candidate.understanding_codes.every((code) => typeof code === "string" && code.trim())) {
    return null;
  }
  return {
    url: candidate.url,
    title: candidate.title,
    resource_type: typeof candidate.resource_type === "string" ? candidate.resource_type : "other",
    source_domain: typeof candidate.source_domain === "string" ? candidate.source_domain : "",
    ai_note: typeof candidate.ai_note === "string" ? candidate.ai_note : "",
    license_status: typeof candidate.license_status === "string" ? candidate.license_status : "link_only",
    understanding_codes: candidate.understanding_codes as string[],
  };
}

/**
 * Parse complete candidates even when the model truncates the outer JSON after
 * emitting valid resource objects. Incomplete objects are ignored; every
 * recovered URL still passes the same acquisition and verification pipeline.
 */
export function parseBatchResources(text: string): BatchResource[] {
  const keyIndex = text.indexOf('"topic_resources"');
  const arrayStart = keyIndex < 0 ? -1 : text.indexOf("[", keyIndex);
  if (arrayStart < 0) return [];

  try {
    const parsed: unknown = JSON.parse(text.slice(text.lastIndexOf("{", keyIndex), text.lastIndexOf("}") + 1));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const topicResources = (parsed as Record<string, unknown>).topic_resources;
      if (!Array.isArray(topicResources)) return [];
      return topicResources
        .map(normalizeBatchResource)
        .filter((candidate): candidate is BatchResource => candidate !== null);
    }
  } catch {
    // A truncated outer object can still contain complete, independently
    // parseable candidate objects. Fall through to the bounded scanner.
  }

  const resources: BatchResource[] = [];
  let objectStart = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = arrayStart + 1; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      if (depth === 0) objectStart = i;
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0 && objectStart >= 0) {
        try {
          const resource = normalizeBatchResource(JSON.parse(text.slice(objectStart, i + 1)));
          if (resource) resources.push(resource);
        } catch {
          // Ignore this malformed item and continue parsing later complete ones.
        }
        objectStart = -1;
      }
    } else if (char === "]" && depth === 0) {
      break;
    }
  }
  return resources;
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
export type ProcessJobOutcome = 'completed' | 'failed' | 'yielded' | 'ownership_lost';

export async function releaseDeadlineYield(
  job: JobClaimResult,
  release: typeof releaseJobClaim = releaseJobClaim,
  signal?: AbortSignal
): Promise<ProcessJobOutcome> {
  let released = false;
  try {
    released = await release(job.id, job.claim_token!, job.claim_version, signal);
  } catch (error) {
    console.warn('[worker] Deadline claim release failed; stale-lease recovery will decide ownership', {
      job_id: job.id,
      error_name: error instanceof Error ? error.name : 'UnknownError',
    });
  }
  if (!released) {
    console.warn('[worker] Deadline yield could not release claim; stale-lease recovery will decide ownership', { job_id: job.id });
    return 'ownership_lost';
  }
  return 'yielded';
}

async function releaseClaimForYield(job: JobClaimResult, deadline?: ReturnType<typeof createWorkerDeadline>): Promise<boolean> {
  try {
    return deadline
      ? await deadline.runCleanup((signal) => releaseJobClaim(job.id, job.claim_token!, job.claim_version, signal))
      : await releaseJobClaim(job.id, job.claim_token!, job.claim_version);
  } catch (error) {
    console.warn('[worker] Fenced claim release failed; lease recovery will decide ownership', {
      job_id: job.id,
      error_name: error instanceof Error ? error.name : 'UnknownError',
    });
    return false;
  }
}

export async function finalizeJobPublication(
  job: JobClaimResult,
  finalize: typeof publishAndCompleteJob = publishAndCompleteJob,
  signal?: AbortSignal
): Promise<ProcessJobOutcome> {
  return finalize({
    jobId: job.id,
    claimToken: job.claim_token!,
    claimVersion: job.claim_version,
    signal,
  });
}

export async function processJob(
  job: JobClaimResult,
  invocationDeadline?: ReturnType<typeof createWorkerDeadline>
): Promise<ProcessJobOutcome> {
  const jobId = job.id;
  const claimToken = job.claim_token;
  const claimVersion = job.claim_version;
  const budgetLimits = job.budget_limits;
  const inputData = job.input_data as Record<string, unknown> | null;
  const curriculumId = job.curriculum_id;
  const maxAiCalls = budgetLimits?.max_ai_calls ?? DEFAULT_BUDGET_LIMITS.max_ai_calls;
  const ownsDeadline = !invocationDeadline;
  const deadline = invocationDeadline ?? createWorkerDeadline();

  if (!curriculumId) {
    try {
      const failed = await failJob(job.id, job.claim_token!, job.claim_version, 'No curriculum_id on job', deadline.cleanupSignal());
      return failed ? 'failed' : 'ownership_lost';
    } finally {
      if (ownsDeadline) deadline.dispose();
    }
  }

  // Heartbeat interval
  const heartbeatInterval = setInterval(async () => {
    const { renewLease } = await import('@/lib/acquisition/jobService');
    const renewed = await renewLease(job.id, job.claim_token!, deadline.signal);
    if (!renewed) {
      clearInterval(heartbeatInterval);
    }
  }, 60_000); // Every 60 seconds

  try {
    deadline.check();
    // Step 2: Get curriculum and build skeleton
    const supabase = getAdminClient();
    const { data: curriculum, error: curriculumError } = await withAbortSignal(supabase
      .from('curricula')
      .select('*')
      .eq('id', curriculumId)
      .single(), deadline.signal);
    deadline.check();
    if (curriculumError) throw new Error(`Failed to load curriculum: ${curriculumError.message}`);

    if (!curriculum) {
      const { failJob } = await import('@/lib/acquisition/jobService');
      return await failJob(job.id, job.claim_token!, job.claim_version, 'Curriculum not found', deadline.signal)
        ? 'failed' : 'ownership_lost';
    }

    const curriculumNotes = curriculum.notes ? JSON.parse(curriculum.notes) as Record<string, unknown> : {};
    const jobState = await getJobById(job.id, deadline.signal);
    if (!jobState) throw new Error('Unable to read acquisition job checkpoint');
    const storedSkeletonValue = (jobState.result_data as { skeleton?: unknown } | null)?.skeleton;
    const { data: existingTopics, error: existingTopicsError } = await withAbortSignal(supabase
      .from('nodes').select('id').eq('curriculum_id', curriculumId), deadline.signal);
    deadline.check();
    if (existingTopicsError) throw new Error(`Failed to inspect existing topic rows: ${existingTopicsError.message}`);
    const skeletonState = classifySkeletonCheckpoint(storedSkeletonValue, existingTopics?.length ?? 0);
    let skeleton = skeletonState.status === 'persisted' ? skeletonState.skeleton : null;
    if (skeletonState.status === 'invalid_checkpoint') {
      throw new Error('Persisted skeleton checkpoint is malformed; manual recovery required');
    }
    if (skeletonState.status === 'legacy_ambiguous') {
      return await failJob(job.id, job.claim_token!, job.claim_version,
        'legacy_structure_without_skeleton: existing topic rows cannot prove full structure; operator recovery required', deadline.signal)
        ? 'failed' : 'ownership_lost';
    }

    // Source discovery cache remains independent of the structural checkpoint.
    const persistedSources = (jobState.result_data as { discoveredSources?: unknown } | null)?.discoveredSources;
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
    let structureMaterialized = false;
    if (!skeleton) {
      deadline.check();
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
      const skeletonReservationId = stableAttemptUuid(job.id, 'skeleton');
      const skeletonReservation = await reserveAICall(
        job.id, job.claim_token!, job.claim_version,
        maxAiCalls,
        skeletonReservationId,
        deadline.signal
      );

      if (!skeletonReservation.reserved) {
        if (skeletonReservation.reason === 'budget_exhausted') {
          const failed = await failJob(job.id, job.claim_token!, job.claim_version,
            'AI call budget exhausted before a skeleton was saved', deadline.signal);
          if (!failed) return 'ownership_lost';
        }
        return skeletonReservation.reason === 'budget_exhausted' ? 'failed' : 'ownership_lost';
      }

      deadline.checkBeforeExpensiveOperation();
      const skeletonText = await callAISkeleton(skeletonPrompt, deadline.signal);
      const generatedSkeleton = parseSkeleton(skeletonText);
      if (!generatedSkeleton) {
        const { failJob } = await import('@/lib/acquisition/jobService');
        return await failJob(job.id, job.claim_token!, job.claim_version, 'Failed to parse skeleton', deadline.signal)
          ? 'failed' : 'ownership_lost';
      }

      deadline.check();
      const saveResult = await saveSkeletonBeforeMaterialization(
        () => saveJobSkeleton({
          jobId: job.id, claimToken: job.claim_token!, claimVersion: job.claim_version, skeleton: generatedSkeleton,
          signal: deadline.signal,
        }),
        () => materializeSkeletonRows(supabase, curriculumId, generatedSkeleton, () => deadline.check(), deadline.signal)
      );
      if (saveResult.status === 'ownership_lost') return 'ownership_lost';
      nodeIds.push(...saveResult.result);
      structureMaterialized = true;
      skeleton = generatedSkeleton;
    } else {
      console.log(`[worker] Reusing immutable skeleton checkpoint with ${skeleton.nodes.length} topics`);
    }

    // Re-materialize the entire expected structure on every resume. The
    // immutable job checkpoint plus stable keys make interrupted writes repairable.
    if (!structureMaterialized) {
      nodeIds.push(...await materializeSkeletonRows(supabase, curriculumId, skeleton, () => deadline.check(), deadline.signal));
    }
    discoveryTitle = skeleton.title;

    // Read checkpoint to skip already-completed topics
    const jobData = await getJobById(job.id, deadline.signal);
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

      const sourcesReservationId = stableAttemptUuid(job.id, 'sources');
      deadline.check();
      const sourcesReservation = await reserveAICall(
        job.id, job.claim_token!, job.claim_version,
        maxAiCalls,
        sourcesReservationId,
        deadline.signal
      );

      if (sourcesReservation.reserved) {
        deadline.checkBeforeExpensiveOperation();
        const sourcesText = await callAISources(sourcesPrompt, deadline.signal);
        deadline.check();
        discoveredSources = parseSources(sourcesText);
        // Persist so a resumed invocation does not re-spend this AI call.
        deadline.check();
        const savedSources = await saveJobSources(
          job.id, job.claim_token!, job.claim_version, discoveredSources, deadline.signal
        );
        if (!savedSources) throw new Error('Failed to persist discovered source checkpoint');
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
        const released = await releaseClaimForYield(job, deadline);
        if (!released) {
          // release failed: claim already lost (stolen by another worker) OR
          // release refused (e.g., yield cap reached). In either case, do not
          // continue — the job will be reclaimed by the cron worker and resume
          // from the checkpoint.
          console.log(
            `[worker] release_job_claim returned false — ownership lost or yield refused; yielding for next cron run`
          );
        }
        return released ? 'yielded' : 'ownership_lost';
      }
      topicsProcessedThisInvocation++;

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

      const discoveryMetrics = createTopicDiscoveryMetrics();
      let coverageOutcome: Awaited<ReturnType<typeof runBoundedCoverageAttempts>>;
      try {
        coverageOutcome = await runBoundedCoverageAttempts({
        maxAttempts: MAX_COVERAGE_ATTEMPTS,
        initialAttempts: storedCoverageAttempts(jobData?.result_data, 'topic', nodeId),
        attemptIdFor: (attemptIndex) => stableAttemptUuid(job.id, 'topic', nodeId, String(attemptIndex)),
        threshold: 3,
        attempt: async (attemptIndex) => {
          deadline.checkBeforeExpensiveOperation();
          const reservation = await reserveAICall(
            job.id, job.claim_token!, job.claim_version, maxAiCalls,
            stableAttemptUuid(job.id, 'topic', nodeId, String(attemptIndex)), deadline.signal
          );
          if (!reservation.reserved) {
            return reservation.reason === "budget_exhausted" ? "budget_exhausted" : "ownership_lost";
          }
          deadline.checkBeforeExpensiveOperation();
          const responseText = await callAIDiscover(topicPrompt, {
            curriculumId,
            jobId: job.id,
            topicId: nodeId,
          }, deadline.signal);
          discoveryMetrics.responseTextChars += responseText.length;
          const candidates: ResourceCandidate[] = parseCandidates(responseText);
          discoveryMetrics.parsedCandidates += candidates.length;
          for (const candidate of candidates) {
            if (!candidate || typeof candidate.url !== 'string' || !candidate.url.trim() ||
                typeof candidate.title !== 'string' || !candidate.title.trim()) {
              discoveryMetrics.rejectedUrlOrTitle++;
              continue;
            }
            const resourceType = normalizeResourceType(candidate.resource_type);
            let mappedCandidate: ReturnType<typeof mapToDiscoveryCandidate>;
            try {
              mappedCandidate = mapToDiscoveryCandidate({ ...candidate, resource_type: resourceType }, []);
            } catch {
              discoveryMetrics.rejectedUrlOrTitle++;
              continue;
            }
            deadline.checkBeforeExpensiveOperation();
            const acquisitionResult = await acquireCandidate(
              { url: mappedCandidate.url, title: mappedCandidate.title, sourceDomain: mappedCandidate.sourceDomain, resourceType: mappedCandidate.resourceType, aiNote: mappedCandidate.aiNote },
              { ...DEFAULT_ACQUISITION_OPTIONS, timeoutMs: 8000, signal: deadline.signal },
            );
            deadline.check();
            if (!acquisitionResult.success) {
              const code = acquisitionResult.error?.code;
              if (code === 'EMPTY_CONTENT' || code === 'UNUSABLE_INTERSTITIAL') {
                discoveryMetrics.contentExtractionFailures++;
                if (code === 'UNUSABLE_INTERSTITIAL') discoveryMetrics.interstitialPageFailures++;
              }
              else if (code && URL_VALIDATION_FAILURES.has(code)) discoveryMetrics.rejectedUrlOrTitle++;
              else discoveryMetrics.fetchFailures++;
              continue;
            }
            if (!acquisitionResult.acquiredPage || !acquisitionResult.structuredContent) {
              discoveryMetrics.contentExtractionFailures++;
              continue;
            }
            const { acquiredPage, structuredContent } = acquisitionResult;
            let educationalEvidence: ReturnType<typeof extractEducationalEvidence>;
            let verificationResult: VerificationResult;
            try {
              educationalEvidence = extractEducationalEvidence(structuredContent, {
                topicTitle: node.title,
                conceptDescription: node.major_understandings.map((mu) => mu.description).join(" "),
              });
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
              discoveryMetrics.verificationRejections++;
              continue;
            }
            if (verificationResult.status !== 'verified') discoveryMetrics.verificationRejections++;
            try {
              const persistResult = await persistWithFence(job.id, job.claim_token!, {
                acquiredPage,
                structuredContent,
                educationalEvidence,
                verificationResult,
                target: { nodeId },
                acquisitionJobId: job.id,
                callerMetadata: {
                  resourceType: mappedCandidate.resourceType,
                  licenseStatus: mappedCandidate.licenseStatus,
                  aiNote: candidate.ai_note ?? null,
                },
              }, deadline.signal);
              requireSuccessfulPersistence(persistResult, job.id, nodeId);
              if (persistResult.resource_id) discoveryMetrics.persistenceSuccesses++;
              else discoveryMetrics.persistenceFailures++;
            } catch (error) {
              discoveryMetrics.persistenceFailures++;
              throw error;
            }
          }
          return "attempted";
        },
        measureEligibleResources: async () => {
            deadline.check();
          const { data, error } = await withAbortSignal(supabase.from("resources").select("id")
            .eq("node_id", nodeId).eq("status", "approved").eq("content_type_verified", true), deadline.signal);
          deadline.check();
          if (error) throw new Error(`Failed to measure topic resource coverage: ${error.message}`);
          const eligibleAssociations = data?.length ?? 0;
          discoveryMetrics.eligibleAssociations = eligibleAssociations;
          return eligibleAssociations;
        },
        record: async ({ resourcesFound, sufficient, budgetExhausted, attemptId }) => {
          deadline.check();
          const result = await recordResourceCoverageAttempt({
            jobId: job.id, claimToken: job.claim_token!, claimVersion: job.claim_version,
            phase: "topic", targetId: nodeId, attemptId, resourcesFound, sufficient,
            maxAttempts: MAX_COVERAGE_ATTEMPTS, budgetExhausted, signal: deadline.signal,
          });
          if (result?.status === "insufficient") {
            console.warn(`[worker] Topic ${nodeId} ended with insufficient eligible resource coverage (${resourcesFound}/3)`);
          }
          return result;
        },
        });
      } finally {
        logTopicDiscoveryMetrics(nodeId, discoveryMetrics);
      }
      if (coverageOutcome === "ownership_lost") return 'ownership_lost';
    }

    // Step 6: Background per-understanding batch discovery.
    // Returns false when it yielded (quota exhausted) so we do NOT publish or
    // complete the job — the next cron invocation resumes from the batch
    // checkpoint.
    const batchOutcome = await processBatchDiscovery(
      job,
      discoveryTitle,
      nodeIds,
      discoveredSources.map((source) => source.domain),
      deadline
    );

    if (batchOutcome !== true) {
      // Yielded: claim already released inside processBatchDiscovery.
      return batchOutcome;
    }

    // Final completion: only mark the job 'completed' if ALL work succeeded
    // and there is enough invocation budget to perform the terminal write.
    deadline.checkBeforeExpensiveOperation();
    const finalization = await finalizeJobPublication(job, publishAndCompleteJob, deadline.signal);

    if (finalization === 'ownership_lost') {
      // Atomic publication rejected this stale or expired claim. The job
      // will be recovered or retried by the cron worker. Do NOT publish.
      console.error(
        `[worker] atomic publication rejected — job ${job.id} may have been reclaimed; leaving curriculum unpublished`
      );
      return 'ownership_lost';
    }

    // Publication and terminal job completion were committed atomically.
    return 'completed';

  } catch (error) {
    if (error instanceof WorkerYieldRequested || deadline.signal.aborted) {
      console.info('[worker] Invocation budget reached; releasing claim for checkpoint resume', { job_id: job.id });
      return releaseDeadlineYield(job, releaseJobClaim, deadline.cleanupSignal());
    }
    console.error('Job processing error:', error);
    const { failJob } = await import('@/lib/acquisition/jobService');
    try {
      const failureRecorded = await failJob(job.id, job.claim_token!, job.claim_version,
        error instanceof Error ? error.message : 'Unknown error', deadline.cleanupSignal());
      if (!failureRecorded) return 'ownership_lost';
    } catch (failureWriteError) {
      console.error('[worker] Unable to persist job failure before invocation ends', {
        job_id: job.id,
        error_name: failureWriteError instanceof Error ? failureWriteError.name : 'UnknownError',
      });
      return 'ownership_lost';
    }
    return 'failed';
  } finally {
    clearInterval(heartbeatInterval);
    if (ownsDeadline) deadline.dispose();
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
  nodeIds: Array<{ nodeId: string; node: SkeletonNode }>,
  prioritizedDomains: string[] = [],
  deadline?: ReturnType<typeof createWorkerDeadline>
): Promise<true | 'yielded' | 'ownership_lost'> {
  const budgetLimits = job.budget_limits;
  const maxAiCalls = budgetLimits?.max_ai_calls ?? DEFAULT_BUDGET_LIMITS.max_ai_calls;

  const supabase = getAdminClient();
  deadline?.check();
  const { data: curriculumRow, error: curriculumError } = await withAbortSignal(supabase
    .from('curricula')
    .select('title')
    .eq('id', job.curriculum_id)
    .single(), deadline?.signal);
  deadline?.check();
  if (curriculumError) throw new Error(`Failed to load curriculum for batch discovery: ${curriculumError.message}`);

  const bgCurriculumTitle = curriculumRow?.title ?? discoveryTitle;

  // Read the batch-phase checkpoint so a resumed invocation skips topics whose
  // batch discovery already completed.
  const batchJobData = await getJobById(job.id, deadline?.signal);
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

    deadline?.check();
    const { data: muRows, error: muError } = await withAbortSignal(supabase
      .from('major_understandings')
      .select('id, code, description, external_key')
      .eq('node_id', nodeId), deadline?.signal);
    deadline?.check();
    if (muError) throw new Error(`Failed to load understandings for batch discovery: ${muError.message}`);

    if (!muRows || muRows.length === 0) continue;

    // Empty topics have no per-understanding discovery work, so do not let
    // them consume the bounded batch quota. Match the stream route's ordering:
    // count only topics that can actually enter batch discovery.
    if (batchTopicsProcessed >= MAX_TOPICS_PER_INVOCATION) {
      console.log(
        `[worker] Batch quota (${MAX_TOPICS_PER_INVOCATION}) reached, releasing claim for next cron run`
      );
      const released = await releaseClaimForYield(job, deadline);
      if (!released) {
        console.log(
          `[worker] release_job_claim returned false — ownership lost or yield refused; yielding for next cron run`
        );
      }
      return released ? 'yielded' : 'ownership_lost';
    }
    batchTopicsProcessed++;

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
    const prompt = buildTopicBatchPrompt(batchNode, bgCurriculumTitle, prioritizedDomains);
    const muIds = muRows.map((mu) => mu.id as string);
    const coverageOutcome = await runBoundedCoverageAttempts({
      maxAttempts: MAX_COVERAGE_ATTEMPTS,
      initialAttempts: storedCoverageAttempts(batchJobData?.result_data, 'batch', nodeId),
      attemptIdFor: (attemptIndex) => stableAttemptUuid(job.id, 'batch', nodeId, String(attemptIndex)),
      threshold: 2,
      attempt: async (attemptIndex) => {
        deadline?.checkBeforeExpensiveOperation();
        const reservation = await reserveAICall(
          job.id, job.claim_token, job.claim_version, maxAiCalls,
          stableAttemptUuid(job.id, 'batch', nodeId, String(attemptIndex)), deadline?.signal
        );
        if (!reservation.reserved) {
          return reservation.reason === "budget_exhausted" ? "budget_exhausted" : "ownership_lost";
        }
        deadline?.checkBeforeExpensiveOperation();
        const batchText = await callAITopicBatch(prompt, deadline?.signal);
        const batchResources = parseBatchResources(batchText);
        let associatedTargetCount = 0;
        let malformedCandidateCount = 0;
        let fetchFailureCount = 0;
        let contentExtractionFailureCount = 0;
        let interstitialPageFailureCount = 0;
        let verificationFailureCount = 0;
        let persistedAssociationCount = 0;
        for (const candidate of batchResources) {
          if (!candidate.url || !candidate.title) continue;

          const targetMuIds = mapUnderstandingCodesToIds(
            candidate.understanding_codes,
            muRows.map((mu) => ({
              id: mu.id as string,
              code: (mu.code as string | null) ?? null,
              external_key: (mu.external_key as string | null) ?? null,
            }))
          );
          if (targetMuIds.length === 0) {
            malformedCandidateCount++;
            console.warn(`[worker] Skipping unassociated batch resource for topic ${nodeId}`);
            continue;
          }
          associatedTargetCount += targetMuIds.length;

          for (const muId of targetMuIds) {
            let sourceDomain = candidate.source_domain;
            try {
              sourceDomain ||= new URL(candidate.url).hostname;
            } catch {
              malformedCandidateCount++;
              continue;
            }
            const discoveryCandidate = {
              url: candidate.url,
              title: candidate.title,
              sourceDomain,
              resourceType: normalizeResourceType(candidate.resource_type),
              aiNote: candidate.ai_note || '',
            };

            const licenseStatus = candidate.license_status === 'cc_open' ? 'cc_open' : 'link_only';
            const resourceType = normalizeResourceType(candidate.resource_type);

            deadline?.checkBeforeExpensiveOperation();
            const acquisitionResult = await acquireCandidate(
              { url: discoveryCandidate.url, title: discoveryCandidate.title, sourceDomain: discoveryCandidate.sourceDomain, resourceType, aiNote: discoveryCandidate.aiNote },
              { ...DEFAULT_ACQUISITION_OPTIONS, timeoutMs: 8000, signal: deadline?.signal },
            );
            deadline?.check();

            if (!acquisitionResult.success || !acquisitionResult.acquiredPage || !acquisitionResult.structuredContent) {
              if (acquisitionResult.error?.code === 'EMPTY_CONTENT' ||
                  acquisitionResult.error?.code === 'UNUSABLE_INTERSTITIAL') {
                contentExtractionFailureCount++;
                if (acquisitionResult.error?.code === 'UNUSABLE_INTERSTITIAL') {
                  interstitialPageFailureCount++;
                }
              } else {
                fetchFailureCount++;
              }
              continue;
            }

            const { acquiredPage, structuredContent } = acquisitionResult;
            let educationalEvidence: ReturnType<typeof extractEducationalEvidence>;
            let verificationResult: VerificationResult;
            try {
              const targetUnderstanding = muRows.find((mu) => mu.id === muId);
              educationalEvidence = extractEducationalEvidence(structuredContent, {
                topicTitle: node.title,
                conceptDescription: targetUnderstanding?.description,
              });
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
              verificationFailureCount++;
              continue;
            }
            if (verificationResult.status !== 'verified') verificationFailureCount++;
            deadline?.check();
            const persistResult = await persistWithFence(job.id, job.claim_token, {
              acquiredPage,
              structuredContent,
              educationalEvidence,
              verificationResult,
              target: { understandingId: muId },
              acquisitionJobId: job.id,
              callerMetadata: { resourceType, licenseStatus, aiNote: candidate.ai_note ?? null },
            }, deadline?.signal);
            requireSuccessfulPersistence(persistResult, job.id, nodeId);
            persistedAssociationCount++;
          }
        }
        console.info('[worker] Batch candidate processing summary', {
          topic_id: nodeId,
          response_chars: batchText.length,
          parsed_candidates: batchResources.length,
          associated_targets: associatedTargetCount,
          malformed_or_unassociated: malformedCandidateCount,
          fetch_failures: fetchFailureCount,
          content_extraction_failures: contentExtractionFailureCount,
          interstitial_page_failures: interstitialPageFailureCount,
          verification_failures: verificationFailureCount,
          persisted_rows: persistedAssociationCount,
        });
        return "attempted";
      },
      measureEligibleResources: async () => {
        deadline?.check();
        const { data, error } = await withAbortSignal(supabase.from("resources").select("major_understanding_id")
          .in("major_understanding_id", muIds).eq("status", "approved").eq("content_type_verified", true), deadline?.signal);
        deadline?.check();
        if (error) throw new Error(`Failed to measure understanding resource coverage: ${error.message}`);
        const rows = data ?? [];
        return Math.min(...muIds.map((muId) => rows.filter((row) => row.major_understanding_id === muId).length));
      },
      record: async ({ resourcesFound, sufficient, budgetExhausted, attemptId }) => {
        deadline?.check();
        const result = await recordResourceCoverageAttempt({
          jobId: job.id, claimToken: job.claim_token, claimVersion: job.claim_version,
          phase: "batch", targetId: nodeId, attemptId, resourcesFound, sufficient,
          maxAttempts: MAX_COVERAGE_ATTEMPTS, budgetExhausted, signal: deadline?.signal,
        });
        if (result?.status === "insufficient") {
          console.warn(`[worker] Understanding coverage in topic ${nodeId} ended insufficient (minimum ${resourcesFound}/2 per understanding)`);
        }
        return result;
      },
    });
    if (coverageOutcome === "ownership_lost") return 'ownership_lost';
  }

  // Every topic's batch discovery has been processed.
  return true;
}

// Re-export functions that need to be imported dynamically
export { persistWithFence, advanceCheckpoint, completeJob, failJob, recoverStaleJobs, getJobById, reserveAICall };
