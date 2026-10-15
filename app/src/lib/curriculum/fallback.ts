/**
 * Phase 8 AI-Generated Curriculum Fallback
 * Creates explicitly marked AI-generated curriculum provenance.
 * Per architecture §9: source_type='ai_generated', source_url=null, source_attribution=null
 */

import { persistCurriculumWithSources, getServiceClient } from "./persistence";
import type { NodeWithChildren } from "@/lib/curriculum-data";

/** Tracks created entities for cleanup on failure */
interface CreatedEntities {
  curriculumId: string | null;
  nodeIds: string[];
}

/** Input for creating AI-generated fallback curriculum */
export interface CreateAiFallbackInput {
  /** Topic the student requested */
  topic: string;
  /** Grade level from form */
  gradeLevel: string;
  /** Difficulty from form */
  difficulty: string;
  /** Learning goal from form */
  learningGoal: string;
  /** Time available from form */
  timeAvailable: string;
  /** Existing knowledge from form */
  existingKnowledge: string;
  /** Added context from form */
  addedContext: string;
  /** Generated curriculum structure (nodes with understandings) */
  nodes: NodeWithChildren[];
  /** Reason for fallback */
  fallbackReason: string;
}

/** Result of AI fallback creation */
export interface AiFallbackResult {
  curriculumId: string;
  sourceId: string;
}

/**
 * Cleanup created entities on failure.
 * Deletes in dependency-safe order: major_understandings -> nodes -> curriculum.
 * Never deletes pre-existing rows (only those created in this attempt).
 */
async function cleanup(
  supabase: ReturnType<typeof getServiceClient>,
  created: CreatedEntities,
  originalError: Error
): Promise<void> {
  const errors: string[] = [];

  // Delete major_understandings for created nodes (cascades from nodes, but explicit is safer)
  if (created.nodeIds.length > 0) {
    try {
      const { error: muError } = await supabase
        .from("major_understandings")
        .delete()
        .in("node_id", created.nodeIds);
      if (muError) errors.push(`major_understandings cleanup failed: ${muError.message}`);
    } catch (e) {
      errors.push(`major_understandings cleanup exception: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Delete nodes (cascades to major_understandings due to FK ON DELETE CASCADE)
  if (created.nodeIds.length > 0) {
    try {
      const { error: nodeError } = await supabase
        .from("nodes")
        .delete()
        .in("id", created.nodeIds);
      if (nodeError) errors.push(`nodes cleanup failed: ${nodeError.message}`);
    } catch (e) {
      errors.push(`nodes cleanup exception: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Delete curriculum (cascades to curriculum_sources, nodes, major_understandings due to FK ON DELETE CASCADE)
  if (created.curriculumId) {
    try {
      const { error: currError } = await supabase
        .from("curricula")
        .delete()
        .eq("id", created.curriculumId);
      if (currError) errors.push(`curriculum cleanup failed: ${currError.message}`);
    } catch (e) {
      errors.push(`curriculum cleanup exception: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // If cleanup had errors, append to original error
  if (errors.length > 0) {
    const cleanupError = new Error(`Cleanup failed: ${errors.join("; ")}`);
    // Attach original error for debugging
    (cleanupError as any).originalError = originalError;
    (cleanupError as any).cleanupErrors = errors;
    throw cleanupError;
  }
}

/**
 * Create an AI-generated fallback curriculum with explicit provenance.
 * Per architecture §9:
 * - source_type = 'ai_generated'
 * - source_url = null
 * - source_attribution = null
 * Provenance record gets verification_state = 'verified' (provenance is accurate)
 * with structure_match_info documenting the fallback reason.
 */
export async function createAiGeneratedCurriculum(
  input: CreateAiFallbackInput
): Promise<AiFallbackResult> {
  const supabase = getServiceClient();
  const created: CreatedEntities = { curriculumId: null, nodeIds: [] };

  try {
    // Create the curriculum record
    const { data: curriculum, error: curriculumError } = await supabase
      .from("curricula")
      .insert({
        title: input.topic.trim(),
        subject: input.topic.trim(),
        source_type: "ai_organized", // Legacy enum value
        status: "draft",
        notes: JSON.stringify({
          grade_level: input.gradeLevel,
          difficulty: input.difficulty,
          learning_goal: input.learningGoal,
          time_available: input.timeAvailable,
          existing_knowledge: input.existingKnowledge,
          added_context: input.addedContext,
          fallback_reason: input.fallbackReason
        })
      })
      .select("id")
      .single();

    if (curriculumError) {
      throw new Error(`Failed to create curriculum: ${curriculumError.message}`);
    }

    const curriculumId = curriculum.id;
    created.curriculumId = curriculumId;

    // Insert nodes and major understandings
    for (const node of input.nodes) {
      const { data: nodeRow, error: nodeError } = await supabase
        .from("nodes")
        .insert({
          curriculum_id: curriculumId,
          title: node.title,
          order_index: node.order_index,
          exam_weight_pct: node.exam_weight_pct ?? null,
          claim_statement: node.claim_statement ?? null
        })
        .select("id")
        .single();

      if (nodeError) {
        await cleanup(supabase, created, new Error(`Failed to insert node: ${nodeError.message}`));
        throw new Error(`Failed to insert node: ${nodeError.message}`);
      }

      if (!nodeRow) {
        await cleanup(supabase, created, new Error("Node insert succeeded but no row returned"));
        throw new Error("Node insert succeeded but no row returned");
      }

      created.nodeIds.push(nodeRow.id);

      if (node.major_understandings.length > 0) {
        const mus = node.major_understandings.map((mu, i) => ({
          node_id: nodeRow.id,
          external_key: mu.external_key ?? mu.code ?? `${node.order_index}.${i + 1}`,
          code: mu.code ?? null,
          description: mu.description,
          order_index: i
        }));

        const { error: muError } = await supabase.from("major_understandings").insert(mus);
        if (muError) {
          await cleanup(supabase, created, new Error(`Failed to insert major understandings: ${muError.message}`));
          throw new Error(`Failed to insert major understandings: ${muError.message}`);
        }
      }
    }

    // Persist AI-generated provenance
    const result = await persistCurriculumWithSources({
      curriculumId,
      title: input.topic.trim(),
      subject: input.topic.trim(),
      nodes: input.nodes,
      provenance: {
        source_type: "ai_generated",
        source_url: null,
        source_title: null,
        source_author: null,
        source_institution: null,
        verification_state: "verified", // Provenance record is accurate
        structure_match_info: {
          unitCount: input.nodes.length,
          understandingCount: input.nodes.reduce((sum, n) => sum + n.major_understandings.length, 0),
          wordCount: 0,
          hasRecognizableStructure: true,
          evidence: "ai_fallback"
        },
        notes: `AI-generated fallback: ${input.fallbackReason}. Per architecture §9: never masquerades as human-written.`
      }
    });

    return result;
  } catch (error) {
    // Cleanup on any failure after curriculum creation
    if (created.curriculumId || created.nodeIds.length > 0) {
      try {
        await cleanup(supabase, created, error instanceof Error ? error : new Error(String(error)));
      } catch (cleanupError) {
        // If cleanup fails, throw a composite error
        const compositeError = new Error(
          `Original error: ${error instanceof Error ? error.message : String(error)}. ` +
          `Cleanup also failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
        );
        (compositeError as any).originalError = error;
        (compositeError as any).cleanupError = cleanupError;
        throw compositeError;
      }
    }
    throw error;
  }
}