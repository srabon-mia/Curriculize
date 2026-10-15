/**
 * Phase 8 Curriculum Discovery Tests
 * Tests for curriculum candidate discovery, verification, and structural signals.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MockSupabaseClient } from "@/lib/phase6-integration/mock-supabase";
import { createSeedSearchProvider } from "@/lib/search/seed-provider";
import { SeedSearchProvider } from "@/lib/search/seed-provider";
import { discoverHumanCurriculumCandidates, verifyCurriculumStructure, rankCurriculumCandidates } from "@/lib/curriculum";

// Mock the supabase server client
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(() => new MockSupabaseClient()),
}));

describe("Curriculum Discovery (Phase 8)", () => {
  let mockClient: MockSupabaseClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = new MockSupabaseClient();
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("SeedSearchProvider", () => {
    it("returns candidates for known seed curriculum topics", async () => {
      const provider = createSeedSearchProvider();
      const candidates = await provider.search("AP Physics C", { maxResults: 5 });

      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates[0].sourceDomain).toBe("apcentral.collegeboard.org");
      expect(candidates[0].url).toContain("apcentral.collegeboard.org");
      expect((candidates[0] as any).source).toBe("seed");
    });

    it("returns candidates for AMC topic", async () => {
      const provider = createSeedSearchProvider();
      const candidates = await provider.search("AMC 12", { maxResults: 5 });

      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates[0].sourceDomain).toBe("maa.org");
    });

    it("returns empty array for unknown topics", async () => {
      const provider = createSeedSearchProvider();
      const candidates = await provider.search("Unknown Topic That Does Not Exist", { maxResults: 5 });

      expect(candidates).toEqual([]);
    });

    it("respects domainFilter", async () => {
      const provider = createSeedSearchProvider();
      const candidates = await provider.search("AP", {
        maxResults: 10,
        domainFilter: ["apcentral.collegeboard.org"]
      });

      expect(candidates.every(c => c.sourceDomain === "apcentral.collegeboard.org")).toBe(true);
    });

    it("returns candidates with correct structure", async () => {
      const provider = createSeedSearchProvider();
      const candidates = await provider.search("AP Physics C", { maxResults: 5 });

      for (const candidate of candidates) {
        expect(candidate.url).toBeDefined();
        expect(candidate.title).toBeDefined();
        expect(candidate.sourceDomain).toBeDefined();
        expect(candidate.resourceType).toBe("textbook");
        expect(candidate.aiNote).toBeDefined();
        // Note: DiscoveryCandidate doesn't have a 'source' property, it's added by the provider
        expect((candidate as any).source).toBe("seed");
      }
    });

    it("limits results to maxResults", async () => {
      const provider = createSeedSearchProvider();
      const candidates = await provider.search("AP", { maxResults: 2 });

      expect(candidates.length).toBeLessThanOrEqual(2);
    });

    it("returns empty array for empty query", async () => {
      const provider = createSeedSearchProvider();
      const candidates = await provider.search("   ", { maxResults: 5 });

      expect(candidates).toEqual([]);
    });
  });

  describe("verifyCurriculumStructure", () => {
    it("returns hasRecognizableStructure=true for well-structured content", () => {
      const structuredContent = {
        statistics: {
          wordCount: 1000,
          headingCount: 8,
          headingCountsByLevel: { 1: 2, 2: 2, 3: 6, 4: 0, 5: 0, 6: 0 },
          paragraphCount: 10,
          linkCount: 5,
          externalLinkCount: 2,
        },
        headings: [],
        blocks: [],
        links: [],
        source: { cleanedHash: "hash1", contentHash: "hash2" },
        metadata: { title: "Test", description: null, author: null, datePublished: null, language: null },
      };

      const result = verifyCurriculumStructure(structuredContent);

      expect(result.signals.hasRecognizableStructure).toBe(true);
      expect(result.signals.unitCount).toBe(4);
      expect(result.signals.understandingCount).toBe(6);
      expect(result.signals.wordCount).toBe(1000);
      expect(result.hasMinimumStructure).toBe(true);
    });

    it("returns hasRecognizableStructure=false for sparse content", () => {
      const structuredContent = {
        statistics: {
          wordCount: 100,
          headingCount: 2,
          headingCountsByLevel: { 1: 1, 2: 0, 3: 1, 4: 0, 5: 0, 6: 0 },
          paragraphCount: 2,
          linkCount: 0,
          externalLinkCount: 0,
        },
        headings: [],
        blocks: [],
        links: [],
        source: { cleanedHash: "hash1", contentHash: "hash2" },
        metadata: { title: "Test", description: null, author: null, datePublished: null, language: null },
      };

      const result = verifyCurriculumStructure(structuredContent);

      expect(result.signals.hasRecognizableStructure).toBe(false);
      expect(result.hasMinimumStructure).toBe(false);
      expect(result.notes.length).toBeGreaterThan(0);
    });

    it("extracts correct unit and understanding counts", () => {
      const structuredContent = {
        statistics: {
          wordCount: 500,
          headingCount: 5,
          headingCountsByLevel: { 1: 2, 2: 1, 3: 3, 4: 1, 5: 0, 6: 0 },
          paragraphCount: 10,
          linkCount: 0,
          externalLinkCount: 0,
        },
        headings: [],
        blocks: [],
        links: [],
        source: { cleanedHash: "hash1", contentHash: "hash2" },
        metadata: { title: "Test", description: null, author: null, datePublished: null, language: null },
      };

      const result = verifyCurriculumStructure(structuredContent);

      expect(result.signals.unitCount).toBe(3);
      expect(result.signals.understandingCount).toBe(3);
      expect(result.signals.wordCount).toBe(500);
    });

    it("handles missing heading levels gracefully", () => {
      const structuredContent = {
        statistics: {
          wordCount: 500,
          headingCount: 3,
          headingCountsByLevel: { 1: 1, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 },
          paragraphCount: 5,
          linkCount: 0,
          externalLinkCount: 0,
        },
        headings: [],
        blocks: [],
        links: [],
        source: { cleanedHash: "hash1", contentHash: "hash2" },
        metadata: { title: "Test", description: null, author: null, datePublished: null, language: null },
      };

      const result = verifyCurriculumStructure(structuredContent);

      expect(result.signals.unitCount).toBe(1);
      expect(result.signals.understandingCount).toBe(0);
    });
  });

  describe("rankCurriculumCandidates", () => {
    it("sorts by domain score first", () => {
      const candidates = [
        { candidate: { sourceDomain: "low.example.com" }, structureSignals: { hasRecognizableStructure: true, wordCount: 1000 } },
        { candidate: { sourceDomain: "high.example.com" }, structureSignals: { hasRecognizableStructure: true, wordCount: 500 } },
      ];

      const domainScores = { "high.example.com": 5, "low.example.com": 2 };
      const ranked = rankCurriculumCandidates(candidates as any, domainScores);

      expect(ranked[0].candidate.sourceDomain).toBe("high.example.com");
      expect(ranked[1].candidate.sourceDomain).toBe("low.example.com");
    });

    it("uses structural signals as tiebreaker", () => {
      const candidates = [
        { candidate: { sourceDomain: "same.example.com" }, structureSignals: { hasRecognizableStructure: false, wordCount: 1000 } },
        { candidate: { sourceDomain: "same.example.com" }, structureSignals: { hasRecognizableStructure: true, wordCount: 500 } },
      ];

      const domainScores = { "same.example.com": 5 };
      const ranked = rankCurriculumCandidates(candidates as any, { "same.example.com": 5 });

      expect(ranked[0].structureSignals.hasRecognizableStructure).toBe(true);
      expect(ranked[1].structureSignals.hasRecognizableStructure).toBe(false);
    });

    it("uses word count as final tiebreaker", () => {
      const candidates = [
        { candidate: { sourceDomain: "same.example.com" }, structureSignals: { hasRecognizableStructure: true, wordCount: 500 } },
        { candidate: { sourceDomain: "same.example.com" }, structureSignals: { hasRecognizableStructure: true, wordCount: 1000 } },
      ];

      const ranked = rankCurriculumCandidates(candidates as any, { "same.example.com": 5 });

      expect(ranked[0].structureSignals.wordCount).toBe(1000);
      expect(ranked[1].structureSignals.wordCount).toBe(500);
    });

    it("handles undefined sourceDomain gracefully", () => {
      const candidates = [
        { candidate: { sourceDomain: undefined }, structureSignals: { hasRecognizableStructure: true, wordCount: 1000 } },
        { candidate: { sourceDomain: "known.example.com" }, structureSignals: { hasRecognizableStructure: true, wordCount: 500 } },
      ];

      const domainScores = { "known.example.com": 5 };
      const ranked = rankCurriculumCandidates(candidates as any, domainScores);

      expect(ranked[0].candidate.sourceDomain).toBe("known.example.com");
    });

    it("stable sort preserves order for equal candidates", () => {
      const candidates = [
        { candidate: { sourceDomain: "same.example.com" }, structureSignals: { hasRecognizableStructure: true, wordCount: 500 }, id: 1 },
        { candidate: { sourceDomain: "same.example.com" }, structureSignals: { hasRecognizableStructure: true, wordCount: 500 }, id: 2 },
      ];

      const ranked = rankCurriculumCandidates(candidates as any, { "same.example.com": 5 });

      expect(ranked[0].id).toBe(1);
      expect(ranked[1].id).toBe(2);
    });
  });

  describe("Structural signals are advisory only", () => {
    it("verifyCurriculumStructure does not affect content verification status", () => {
      const sparseContent = {
        statistics: {
          wordCount: 10,
          headingCount: 0,
          headingCountsByLevel: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 },
          paragraphCount: 1,
          linkCount: 0,
          externalLinkCount: 0,
        },
        headings: [],
        blocks: [{ text: "Short content", tagName: "p" }],
        links: [],
        source: { cleanedHash: "hash1", contentHash: "hash2" },
        metadata: { title: "Test", description: null, author: null, datePublished: null, language: null },
      };

      const result = verifyCurriculumStructure(sparseContent);

      expect(result.signals.hasRecognizableStructure).toBe(false);
      expect(result.signals.unitCount).toBe(0);
      expect(result.notes.length).toBeGreaterThan(0);
    });
  });
});