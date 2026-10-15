/**
 * Phase 8 Curriculum Finder
 * Looks up existing verified curricula in the database.
 * Pure DB lookup - no AI, no acquisition.
 */

import { createClient } from "@/lib/supabase/server";
import type { NodeWithChildren } from "@/lib/curriculum-data";

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