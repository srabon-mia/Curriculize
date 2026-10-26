import { acquireCandidate } from "@/lib/acquisition/engine";
import type { AISearchCitation } from "@/lib/ai/types";
import type { AcquisitionResult } from "@/lib/acquisition/types";

export type CurriculumSourceClaim = {
  source_type: "adapted" | "ai_organized";
  source_attribution: string | null;
  source_url: string | null;
};

export type VerifiedCurriculumSource = {
  source_url: string;
  source_title: string;
  source_author: string | null;
  source_institution: string;
  word_count: number;
};

function normalizedUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.hash = "";
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return null;
  }
}

function institutionFor(hostname: string): string {
  const host = hostname.toLowerCase().replace(/^www\./, "");
  const known: Record<string, string> = {
    "collegeboard.org": "College Board",
    "ibo.org": "International Baccalaureate",
    "openstax.org": "OpenStax",
    "khanacademy.org": "Khan Academy",
  };
  const match = Object.entries(known).find(([domain]) => host === domain || host.endsWith(`.${domain}`));
  if (match) return match[1];
  return host;
}

function credibleEducationalHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host.endsWith(".edu") || host.endsWith(".gov") ||
    ["collegeboard.org", "ibo.org", "openstax.org", "khanacademy.org"].some(
      (domain) => host === domain || host.endsWith(`.${domain}`)
    );
}

/** Accept model attribution only when the cited source was fetched and contains curriculum material. */
export async function verifyCurriculumSource(
  claim: CurriculumSourceClaim,
  citations: AISearchCitation[],
  acquire: (url: string) => Promise<AcquisitionResult> = (url) => acquireCandidate({ url })
): Promise<VerifiedCurriculumSource | null> {
  if (claim.source_type !== "adapted" || !claim.source_url || !claim.source_attribution) return null;
  const claimedUrl = normalizedUrl(claim.source_url);
  if (!claimedUrl || !citations.some((citation) => normalizedUrl(citation.url) === claimedUrl)) return null;

  const acquired = await acquire(claim.source_url);
  if (!acquired.success || !acquired.acquiredPage || !acquired.cleanedPage) return null;
  const finalUrl = normalizedUrl(acquired.acquiredPage.finalUrl);
  if (!finalUrl) return null;
  const parsed = new URL(finalUrl);
  const title = acquired.cleanedPage.title.trim();
  const text = `${title}\n${acquired.cleanedPage.text}`;
  const wordCount = text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
  const hasCurriculumStructure = /\b(curricul(?:um|a)|syllabus|course outline|learning outcomes|standards framework|units of study)\b/i.test(text);
  if (!credibleEducationalHost(parsed.hostname) || !title || wordCount < 40 || !hasCurriculumStructure) return null;

  return {
    source_url: acquired.acquiredPage.finalUrl,
    source_title: title,
    source_author: acquired.structuredContent?.metadata.author?.trim() || null,
    source_institution: institutionFor(parsed.hostname),
    word_count: wordCount,
  };
}

export function applyVerifiedCurriculumSource<T extends CurriculumSourceClaim>(
  skeleton: T,
  source: VerifiedCurriculumSource | null
): T {
  if (!source) {
    return { ...skeleton, source_type: "ai_organized", source_attribution: null, source_url: null };
  }
  return {
    ...skeleton,
    source_type: "adapted",
    source_attribution: [source.source_institution, source.source_title, source.source_author]
      .filter(Boolean).join(" — "),
    source_url: source.source_url,
  };
}

/** Save the verified provenance in the existing curriculum_sources model. */
export async function persistGeneratedCurriculumSource(
  client: any,
  curriculumId: string,
  skeleton: { nodes: Array<{ major_understandings: unknown[] }> },
  source: VerifiedCurriculumSource | null
): Promise<{ error: { message: string } | null }> {
  const { data: previous, error: lookupError } = await client.from("curriculum_sources")
    .select("id")
    .eq("curriculum_id", curriculumId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lookupError) return { error: lookupError };

  const record = {
    curriculum_id: curriculumId,
    source_type: source ? "adapted" : "ai_generated",
    source_url: source?.source_url ?? null,
    source_title: source?.source_title ?? null,
    source_author: source?.source_author ?? null,
    source_institution: source?.source_institution ?? null,
    verification_state: source ? "verified" : "not_applicable",
    structure_match_info: {
      unitCount: skeleton.nodes.length,
      understandingCount: skeleton.nodes.reduce((sum, node) => sum + node.major_understandings.length, 0),
      wordCount: source?.word_count ?? 0,
      hasRecognizableStructure: Boolean(source),
      evidence: source ? "Cited in completed web search and fetched from an educational organization." : "No verifiable human-written curriculum source was confirmed.",
    },
    notes: source ? "Source citation was checked against the completed skeleton web search and fetched successfully." : "No human-authored source attribution is claimed.",
  };
  const result = previous?.id
    ? await client.from("curriculum_sources").update(record).eq("id", previous.id)
    : await client.from("curriculum_sources").insert(record);
  return { error: result.error ?? null };
}
