import { z } from "zod";

/** Schema for topic discovery candidates (array of resources). */
export const CandidateArraySchema = z.array(
  z.object({
    url: z.string().url(),
    title: z.string().min(1),
    resource_type: z.enum(["video", "text", "textbook", "problem_set", "reference_tool", "practice_exam", "other"]),
    source_domain: z.string().min(1),
    ai_note: z.string().min(1),
    license_status: z.enum(["cc_open", "link_only", "unknown_review_needed"]),
  })
);

/** Schema for source discovery response (array of sources). */
export const SourcesArraySchema = z.array(
  z.object({
    domain: z.string().min(1),
    name: z.string().min(1),
    why: z.string().min(1),
    best_for: z.string().min(1),
  })
);
