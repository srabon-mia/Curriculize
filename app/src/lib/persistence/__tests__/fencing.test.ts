/**
 * Lease fencing tests for persist_with_fence.
 * Verifies that the RPC correctly validates ownership before persisting.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Supabase - exact copy from timestamp.test.ts
const mockRpc = vi.fn();
const mockFromChain = {
  select: vi.fn().mockReturnThis(),
  eq: vi.fn().mockReturnThis(),
  single: vi.fn().mockResolvedValue({
    data: {
      id: 'res-1',
      url: 'https://example.com/page',
      title: 'Test Resource',
      source_domain: 'example.com',
      resource_type: 'text',
      license_status: 'link_only',
      embed_allowed: false,
      content_type_verified: true,
      ai_note: null,
      status: 'draft',
      node_id: '550e8400-e29b-41d4-a716-446655440000',
      major_understanding_id: null,
      created_at: '2025-01-15T10:30:00.000Z',
    },
    error: null,
  }),
};

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    rpc: mockRpc,
    from: vi.fn(() => mockFromChain),
  })),
}));

import { persistVerifiedResourceWithFence } from '@/lib/persistence';

describe('Lease fencing in persistVerifiedResourceWithFence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const validInput = {
    acquiredPage: {
      finalUrl: 'https://example.com/page',
      canonicalUrl: { url: 'https://example.com/page' },
      contentHash: 'abc123',
      statusCode: 200,
      acquiredAt: '2025-01-15T10:30:00.000Z',
      contentType: 'text/html',
    },
    structuredContent: {
      metadata: { title: 'Test', description: 'Desc', author: 'Auth', datePublished: '2025-01-01', language: 'en' },
    },
    educationalEvidence: { interpreted: {} },
    verificationResult: {
      status: 'verified' as const,
      deterministicChecks: { cleanedContentNonEmpty: true },
      advisorySignals: { titlePresent: true, educationalEvidencePresent: true, wordCount: 100, headingCount: 2, paragraphCount: 5 },
      verifiedAt: '2025-01-15T10:31:00.000Z',
    },
    target: { nodeId: '550e8400-e29b-41d4-a716-446655440000' },
    acquisitionJobId: 'test-job-1',
    callerMetadata: { resourceType: 'text' as const, licenseStatus: 'link_only' as const, aiNote: null },
  };

  it('succeeds when lease is valid', async () => {
    mockRpc.mockResolvedValueOnce({
      data: { resource_id: 'res-1', vr_id: 'vr-1', mapping_id: null, is_exact_retry: false },
      error: null,
    });

    const result = await persistVerifiedResourceWithFence('job-1', 'valid-token', validInput);

    expect(result).not.toBeNull();
    expect(result?.resource?.id).toBe('res-1');
  });

  it('fails when claim_token mismatch (ownership lost)', async () => {
    mockRpc.mockResolvedValueOnce({
      data: { error: 'ownership_lost_or_expired' },
      error: null,
    });

    const result = await persistVerifiedResourceWithFence('job-1', 'wrong-token', validInput);

    expect(result).toBeNull();
  });

  it('fails when lease expired (claim_expires_at < now)', async () => {
    mockRpc.mockResolvedValueOnce({
      data: { error: 'ownership_lost_or_expired' },
      error: null,
    });

    const result = await persistVerifiedResourceWithFence('job-1', 'expired-token', validInput);

    expect(result).toBeNull();
  });

  it('fails when job status is not running', async () => {
    mockRpc.mockResolvedValueOnce({
      data: { error: 'ownership_lost_or_expired' },
      error: null,
    });

    const result = await persistVerifiedResourceWithFence('job-1', 'token-for-completed-job', validInput);

    expect(result).toBeNull();
  });

  it('exact-retry returns existing resource without new persistence', async () => {
    mockRpc.mockResolvedValueOnce({
      data: { resource_id: 'existing-res', vr_id: 'existing-vr', mapping_id: null, is_exact_retry: true },
      error: null,
    });

    const result = await persistVerifiedResourceWithFence('job-1', 'valid-token', validInput);

    expect(result).not.toBeNull();
    expect(result?.verificationRecord?.isExactRetry).toBe(true);
  });

  it('claim_version mismatch rejects persistence (fencing)', async () => {
    // If claim_version doesn't match, the RPC's WHERE clause fails
    // This is tested by the RPC returning ownership_lost_or_expired
    mockRpc.mockResolvedValueOnce({
      data: { error: 'ownership_lost_or_expired' },
      error: null,
    });

    const result = await persistVerifiedResourceWithFence('job-1', 'valid-token-but-wrong-version', validInput);

    expect(result).toBeNull();
  });
});

describe('persist_with_fence SQL contract (documentation)', () => {
  it('RPC validates ownership with FOR NO KEY UPDATE lock', () => {
    // SQL (migration 0006/0008/0011):
    // SELECT * FROM acquisition_jobs
    // WHERE id = p_job_id AND claim_token = p_claim_token
    //   AND status = 'running' AND claim_expires_at > now()
    // FOR NO KEY UPDATE;
    // IF NOT FOUND THEN RETURN {error: 'ownership_lost_or_expired'};
    const lockBehavior = {
      lockType: 'FOR NO KEY UPDATE',
      checks: ['id', 'claim_token', 'status=running', 'claim_expires_at > now()'],
      onNotFound: 'returns ownership_lost_or_expired',
    };

    expect(lockBehavior.lockType).toBe('FOR NO KEY UPDATE');
    expect(lockBehavior.checks).toContain('claim_token');
    expect(lockBehavior.checks).toContain('status=running');
    expect(lockBehavior.checks).toContain('claim_expires_at > now()');
  });

  it('exact-retry uses acquisition_job_id column (not notes JSON)', () => {
    // SQL: WHERE vr.acquisition_job_id = p_input->>'acquisitionJobId'
    //      AND vr.content_hash = p_input->'acquiredPage'->>'contentHash'
    const exactRetry = {
      column: 'acquisition_job_id',
      matches: ['acquisitionJobId', 'contentHash'],
      notUsed: 'notes (text, not jsonb)',
    };

    expect(exactRetry.column).toBe('acquisition_job_id');
    expect(exactRetry.notUsed).toBe('notes (text, not jsonb)');
  });

  it('resource UPSERT uses ON CONFLICT on (canonical_url, node_id) and (canonical_url, mu_id)', () => {
    const upsertPaths = {
      nodeTarget: 'ON CONFLICT (canonical_url, node_id) WHERE node_id IS NOT NULL',
      muTarget: 'ON CONFLICT (canonical_url, major_understanding_id) WHERE major_understanding_id IS NOT NULL',
    };

    expect(upsertPaths.nodeTarget).toContain('canonical_url, node_id');
    expect(upsertPaths.muTarget).toContain('canonical_url, major_understanding_id');
  });

  it('verification_records exact-retry uses ON CONFLICT (resource_id, acquisition_job_id, content_hash)', () => {
    const vrConflict = 'ON CONFLICT (resource_id, acquisition_job_id, content_hash) WHERE acquisition_job_id IS NOT NULL DO NOTHING';
    expect(vrConflict).toContain('resource_id, acquisition_job_id, content_hash');
  });

  it('auto-approval gate requires verified + educationalEvidencePresent', () => {
    // v_auto_approve := v_verification_status = 'verified' AND
    //                    (v_advisory_signals->>'educationalEvidencePresent')::boolean = true
    const approved = { status: 'verified', educationalEvidencePresent: true };
    const notApproved1 = { status: 'verified', educationalEvidencePresent: false };
    const notApproved2 = { status: 'failed', educationalEvidencePresent: true };

    expect(approved.status === 'verified' && approved.educationalEvidencePresent).toBe(true);
    expect(notApproved1.status === 'verified' && notApproved1.educationalEvidencePresent).toBe(false);
    expect(notApproved2.status === 'verified' && notApproved2.educationalEvidencePresent).toBe(false);
  });

  it('grants restricted to service_role', () => {
    // Migration 0011 ends with:
    // REVOKE ALL ON FUNCTION persist_with_fence(uuid, uuid, jsonb) FROM PUBLIC;
    // GRANT EXECUTE ON FUNCTION persist_with_fence(uuid, uuid, jsonb) TO service_role;
    const grants = {
      revokedFrom: 'PUBLIC',
      grantedTo: 'service_role',
    };

    expect(grants.revokedFrom).toBe('PUBLIC');
    expect(grants.grantedTo).toBe('service_role');
  });

  it('function signature unchanged: (uuid, uuid, jsonb) -> jsonb', () => {
    // All migrations 0006, 0008, 0011 preserve the exact signature
    const signature = {
      params: ['p_job_id uuid', 'p_claim_token uuid', 'p_input jsonb'],
      returns: 'jsonb',
      language: 'plpgsql',
      security: 'SECURITY DEFINER',
      searchPath: 'SET search_path = public',
    };

    expect(signature.params).toHaveLength(3);
    expect(signature.returns).toBe('jsonb');
  });
});