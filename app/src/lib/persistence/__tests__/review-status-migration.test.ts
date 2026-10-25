import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "../supabase/migrations/0018_resource_status_review_protection.sql"),
  "utf8"
);

describe("resource review decision migration", () => {
  it("adds an admin decision marker and preserves the existing RPC signature and authorization", () => {
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS status_reviewed_by uuid REFERENCES auth.users(id)");
    expect(migration).toContain("DROP FUNCTION IF EXISTS public.approve_authoritative_resource_with_fence(uuid, uuid, uuid)");
    expect(migration).toContain("persist_with_fence(\n  p_job_id uuid, p_claim_token uuid, p_input jsonb");
    expect(migration).toContain("SECURITY DEFINER SET search_path = public");
    expect(migration).toContain("claim_token = p_claim_token");
    expect(migration).toContain("claim_expires_at > now()");
    expect(migration).toContain("FOR NO KEY UPDATE");
    expect(migration).toContain("GRANT EXECUTE ON FUNCTION persist_with_fence(uuid, uuid, jsonb) TO service_role");
    expect(migration.indexOf("claim_expires_at > now()")).toBeLessThan(migration.indexOf("-- UPSERT resource"));
    expect(migration.indexOf("Exact-retry check")).toBeLessThan(migration.indexOf("-- UPSERT resource"));
  });

  it("only updates unreviewed drafts on either target conflict and still records verification and mappings", () => {
    expect(migration.match(/WHERE resources\.status = 'draft'\s+AND resources\.status_reviewed_by IS NULL\s+AND NOT EXISTS \(/g)).toHaveLength(2);
    expect(migration).toContain("vr.human_reviewed IS TRUE");
    expect(migration).toContain("ON CONFLICT (resource_id, acquisition_job_id, content_hash)");
    expect(migration).toContain("ON CONFLICT (resource_id, understanding_id) DO NOTHING");
    expect(migration).toContain("SELECT id INTO v_resource_id");
  });

  it("retains the existing verified plus explicit-education approval gate", () => {
    expect(migration).toContain("v_verification_status = 'verified'");
    expect(migration).toContain("(v_advisory_signals->>'educationalEvidencePresent')::boolean = true");
    expect(migration).not.toContain("wordCount')::integer");
    expect(migration).not.toContain("ds.score >=");
  });
});
