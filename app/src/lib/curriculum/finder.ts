/**
 * Phase 8 Curriculum Finder
 * Looks up existing verified curricula in the database.
 * Pure DB lookup - no AI, no acquisition.
 */

import { createClient } from "@/lib/supabase/server";
import type { NodeWithChildren } from "@/lib/curriculum-data";

/**
 * Phase 10: Warm-path curriculum identification helpers.
 *
 * A curriculum created by /api/generate stores the 6 student GenerateForm
 * fields — everything except `topic`, which lives in `title` — inside
 * `curricula.notes` as a JSON string (`JSON.stringify({...})`) at creation
 * time. Two requests that produce byte-identical `notes` JSON are therefore an
 * identical student request, so a *published* curriculum whose notes match a
 * re-submitted request can be served instantly (the warm path) instead of
 * running another AI generation.
 */

/** The full GenerateForm submission — the canonical identity of a student's request. */
export interface CurriculumRequest {
  topic: string;
  grade_level: string;
  difficulty: string;
  existing_knowledge: string;
  learning_goal: string;
  time_available: string;
  added_context: string;
}

/** The 6 form fields persisted into curricula.notes (topic is matched via `title`). */
export type NotesFields = Pick<CurriculumRequest, "grade_level" | "difficulty" | "existing_knowledge" | "learning_goal" | "time_available" | "added_context">;

/**
 * Safely parse a `curricula.notes` cell that may hold JSON or free text.
 * Returns null for null/undefined, empty, non-string, non-object, and array JSON.
 */
export function parseNotesJson(notes: unknown): Record<string, unknown> | null {
  if (notes === null || notes === undefined) return null;
  if (typeof notes !== "string") return null;
  const trimmed = notes.trim();
  if (trimmed === "") return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * True when a curriculum's stored `notes` JSON matches every provided field of
 * a request EXACTLY (parsed value === provided value). Pure & total — never
 * throws. Used to reject any published curriculum that was not built from the
 * same student request.
 */
export function notesMatchRequest(notes: unknown, fields: Partial<NotesFields>): boolean {
  const parsed = parseNotesJson(notes);
  if (!parsed) return false;
  for (const [key, value] of Object.entries(fields)) {
    if (parsed[key] !== value) return false;
  }
  return true;
}

/** Result of finding an existing curriculum */
export interface FoundCurriculum {
  curriculumId: string;
  title: string;
  subject: string;
  sourceType: string;
  sourceAttribution: string | null;
  sourceUrl: string | null;
  nodes: NodeWithChildren[];
}

/**
 * Find an existing published curriculum matching the topic.
 * Uses exact title match first, then fuzzy subject match.
 * Only returns published curricula (RLS enforced).
 */
export async function findExistingCurriculum(
  topic: string,
  gradeLevel?: string
): Promise<FoundCurriculum | null> {
  const supabase = await createClient();

  // First try exact title match (case-insensitive)
  const { data: exactMatch } = await supabase
    .from("curricula")
    .select("*")
    .eq("status", "published")
    .ilike("title", topic.trim())
    .maybeSingle();

  if (exactMatch) {
    const nodes = await getNodesWithUnderstandings(exactMatch.id);
    return {
      curriculumId: exactMatch.id,
      title: exactMatch.title,
      subject: exactMatch.subject,
      sourceType: exactMatch.source_type,
      sourceAttribution: exactMatch.source_attribution,
      sourceUrl: exactMatch.source_url,
      nodes
    };
  }

  // Fallback: fuzzy subject match
  const { data: fuzzyMatches } = await supabase
    .from("curricula")
    .select("*")
    .eq("status", "published")
    .ilike("subject", `%${topic.trim()}%`)
    .limit(1);

  if (fuzzyMatches && fuzzyMatches.length > 0) {
    const match = fuzzyMatches[0];
    const nodes = await getNodesWithUnderstandings(match.id);
    return {
      curriculumId: match.id,
      title: match.title,
      subject: match.subject,
      sourceType: match.source_type,
      sourceAttribution: match.source_attribution,
      sourceUrl: match.source_url,
      nodes
    };
  }

  return null;
}

/**
 * Get nodes with understandings for a curriculum.
 * Reuses existing curriculum-data function.
 */
async function getNodesWithUnderstandings(curriculumId: string): Promise<NodeWithChildren[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("nodes")
    .select("*, major_understandings(id, node_id, external_key, code, description, order_index)")
    .eq("curriculum_id", curriculumId)
    .order("order_index", { ascending: true });

  if (error) throw new Error(`Failed to load nodes: ${error.message}`);

  return (data ?? []).map(node => ({
    ...node,
    major_understandings: [...(node.major_understandings ?? [])].sort(
      (a: NodeWithChildren['major_understandings'][0], b: NodeWithChildren['major_understandings'][0]) =>
        a.order_index - b.order_index
    )
  }));
}