/**
 * Phase 8 Curriculum Persistence
 * Persists curriculum provenance to curriculum_sources table
 * and mirrors to legacy curricula fields for backward compatibility.
 */

import { createClient as createServiceClient } from "@supabase/supabase-js";
import type { NodeWithChildren } from "@/lib/curriculum-data";

/** Input for persisting a curriculum with its provenance */
export interface PersistCurriculumInput {
  /** Curriculum ID (existing or newly created) */
  curriculumId: string;
  /** Curriculum title */
  title: string;
  /** Curriculum subject */
  subject: string;
  /** Nodes with understandings */
  nodes: NodeWithChildren[];
  /** Provenance information */
  provenance: {
    /** Source type: human_written | adapted | ai_generated */
    source_type: "human_written" | "adapted" | "ai_generated";
    /** Source URL (null for ai_generated) */
    source_url: string | null;
    /** Source title */
    source_title: string | null;
    /** Source author */
    source_author: string | null;
    /** Source institution */
    source_institution: string | null;
    /** Verification state: verified | needs_review | failed */
    verification_state: "verified" | "needs_review" | "failed";
    /** Structural match info (advisory signals) */
    structure_match_info: {
      unitCount: number;
      understandingCount: number;
      wordCount: number;
      hasRecognizableStructure: boolean;
      evidence: string;
    };
    /** Additional notes */
    notes: string;
  };
}

/** Result of curriculum persistence */
export interface PersistCurriculumResult {
  curriculumId: string;
  sourceId: string;
}

/** Source row type for mirroring */
interface CurriculumSourceRow {
  id: string;
  source_type: string;
  source_url: string | null;
  source_title: string | null;
  source_author: string | null;
  source_institution: string | null;
  verification_state: string;
  created_at: string;
  source_attribution: string | null;
}

/** Supabase service client for admin operations */
export function getServiceClient() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

/**
 * Persist curriculum with provenance to curriculum_sources
 * and mirror to legacy curricula fields.
 * Uses service role to bypass RLS for admin writes.
 */
export async function persistCurriculumWithSources(
  input: PersistCurriculumInput
): Promise<{ curriculumId: string; sourceId: string }> {
  const supabase = getServiceClient();

  const { curriculumId, provenance } = input;

  // Insert provenance record
  const { data: sourceData, error: sourceError } = await supabase
    .from("curriculum_sources")
    .insert({
      curriculum_id: curriculumId,
      source_type: provenance.source_type,
      source_url: provenance.source_url,
      source_title: provenance.source_title,
      source_author: provenance.source_author,
      source_institution: provenance.source_institution,
      verification_state: provenance.verification_state,
      structure_match_info: provenance.structure_match_info,
      notes: provenance.notes
    })
    .select("id")
    .single();

  if (sourceError) {
    throw new Error(`Failed to insert curriculum_sources: ${sourceError.message}`);
  }

  // Mirror to legacy fields - required operation, must succeed
  await mirrorToLegacy(curriculumId);

  return {
    curriculumId,
    sourceId: sourceData.id
  };
}

/**
 * Mirror the primary curriculum_sources record to legacy curricula fields.
 * Uses most recent source by created_at, tie-break by UUID.
 * Call after every curriculum_sources insert/update.
 * Idempotent and retry-safe: re-running with the same curriculumId
 * produces the same legacy field values.
 */
export async function mirrorToLegacy(curriculumId: string): Promise<void> {
  const supabase = getServiceClient();

  const { data: sources, error } = await supabase
    .from("curriculum_sources")
    .select("*")
    .eq("curriculum_id", curriculumId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: true });

  if (error) {
    throw new Error(`Failed to fetch sources for mirroring: ${error.message}`);
  }

  if (!sources || sources.length === 0) {
    throw new Error(`No provenance record found for curriculum ${curriculumId} - cannot mirror to legacy fields`);
  }

  const primary = sources[0] as CurriculumSourceRow;

  // Map source_type to legacy enum
  const legacySourceType = primary.source_type === "ai_generated" ? "ai_organized" : "adapted";

  // Format attribution
  const attribution = formatAttribution(primary);

  const { error: updateError } = await supabase
    .from("curricula")
    .update({
      source_type: legacySourceType,
      source_attribution: attribution,
      source_url: primary.source_url
    })
    .eq("id", curriculumId);

  if (updateError) {
    throw new Error(`Failed to mirror to legacy fields: ${updateError.message}`);
  }
}

/**
 * Format attribution string from source fields.
 * Deterministic format: "Institution — Title — Author" (non-null parts joined by " — ")
 */
function formatAttribution(src: CurriculumSourceRow): string {
  const parts = [
    src.source_institution,
    src.source_title,
    src.source_author
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(" — ") : (src.source_url ?? "Unknown source");
}