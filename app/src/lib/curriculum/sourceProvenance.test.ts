import { describe, expect, it, vi } from "vitest";
import { applyVerifiedCurriculumSource, persistGeneratedCurriculumSource, verifyCurriculumSource } from "./sourceProvenance";

const claim = {
  source_type: "adapted" as const,
  source_attribution: "Invented source label",
  source_url: "https://apcentral.collegeboard.org/courses/ap-computer-science-a",
};
const citation = [{ url: claim.source_url, title: "AP Computer Science A Course and Exam Description" }];
const fetched = {
  success: true,
  acquiredPage: { finalUrl: claim.source_url },
  cleanedPage: {
    title: "AP Computer Science A Course and Exam Description",
    text: ("Curriculum units of study and learning outcomes for students. ").repeat(12),
  },
} as any;

// College Board-style fetched page using modern AP terminology (no "syllabus", "learning outcomes", etc.)
const fetchedCollegeBoardStyle = {
  success: true,
  acquiredPage: { finalUrl: "https://apcentral.collegeboard.org/courses/ap-statistics" },
  cleanedPage: {
    title: "AP Statistics Course and Exam Description",
    text: "Course Framework. Course at a Glance. Units. Topics. Skills. The AP Statistics course framework is organized into nine units of study. Each unit contains multiple topics and skills that students must master. The course framework provides a clear structure for the course. Teachers use the framework to plan instruction and assessment.",
  },
} as any;

describe("curriculum source provenance", () => {
  it("requires a cited, fetched, credible curriculum page and derives attribution from it", async () => {
    const acquire = vi.fn().mockResolvedValue(fetched);
    const verified = await verifyCurriculumSource(claim, citation, acquire);
    expect(acquire).toHaveBeenCalledWith(claim.source_url);
    expect(verified).toMatchObject({
      source_url: claim.source_url,
      source_title: "AP Computer Science A Course and Exam Description",
      source_institution: "College Board",
    });
    expect(applyVerifiedCurriculumSource(claim, verified)).toMatchObject({
      source_type: "adapted",
      source_attribution: "College Board — AP Computer Science A Course and Exam Description",
      source_url: claim.source_url,
    });
  });

  it("removes attribution when the source was not cited, fetched, or structurally credible", async () => {
    const acquire = vi.fn().mockResolvedValue(fetched);
    expect(await verifyCurriculumSource(claim, [], acquire)).toBeNull();
    expect(acquire).not.toHaveBeenCalled();

    const failed = await verifyCurriculumSource(claim, citation, async () => ({ success: false } as any));
    expect(failed).toBeNull();
    expect(applyVerifiedCurriculumSource(claim, failed)).toEqual({
      source_type: "ai_organized", source_attribution: null, source_url: null,
    });
  });

  it("does not trust a fetched page on an unrecognized host as an authoritative syllabus", async () => {
    const result = await verifyCurriculumSource(
      { ...claim, source_url: "https://example.com/course" },
      [{ url: "https://example.com/course" }],
      async () => ({ ...fetched, acquiredPage: { finalUrl: "https://example.com/course" } }) as any
    );
    expect(result).toBeNull();
  });

  it("accepts College Board-style curriculum pages with Course Framework / Course and Exam Description terminology", async () => {
    const collegeBoardClaim = {
      source_type: "adapted" as const,
      source_attribution: "College Board AP Statistics",
      source_url: "https://apcentral.collegeboard.org/courses/ap-statistics",
    };
    const collegeBoardCitation = [{ url: collegeBoardClaim.source_url, title: "AP Statistics Course and Exam Description" }];
    const acquire = vi.fn().mockResolvedValue(fetchedCollegeBoardStyle);

    const verified = await verifyCurriculumSource(collegeBoardClaim, collegeBoardCitation, acquire);

    expect(acquire).toHaveBeenCalledWith(collegeBoardClaim.source_url);
    expect(verified).not.toBeNull();
    expect(verified).toMatchObject({
      source_url: "https://apcentral.collegeboard.org/courses/ap-statistics",
      source_title: "AP Statistics Course and Exam Description",
      source_institution: "College Board",
    });
    expect(applyVerifiedCurriculumSource(collegeBoardClaim, verified)).toMatchObject({
      source_type: "adapted",
      source_attribution: "College Board — AP Statistics Course and Exam Description",
      source_url: "https://apcentral.collegeboard.org/courses/ap-statistics",
    });
  });

  it("persists source title, institution, canonical URL, and verification evidence", async () => {
    let inserted: Record<string, unknown> | null = null;
    const query: any = {
      select: () => query,
      eq: () => query,
      order: () => query,
      limit: () => query,
      maybeSingle: async () => ({ data: null, error: null }),
      insert: async (row: Record<string, unknown>) => { inserted = row; return { error: null }; },
    };
    const source = await verifyCurriculumSource(claim, citation, async () => fetched);
    const result = await persistGeneratedCurriculumSource(
      { from: () => query },
      "curriculum-1",
      { nodes: [{ major_understandings: [{}, {}] }] },
      source
    );

    expect(result.error).toBeNull();
    expect(inserted).toMatchObject({
      curriculum_id: "curriculum-1",
      source_type: "adapted",
      source_url: claim.source_url,
      source_title: "AP Computer Science A Course and Exam Description",
      source_institution: "College Board",
      verification_state: "verified",
    });
  });
});
