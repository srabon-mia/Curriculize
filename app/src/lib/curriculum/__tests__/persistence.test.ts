/**
 * Phase 8 Curriculum Persistence Tests
 * Tests for curriculum provenance persistence and legacy mirroring.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MockSupabaseClient } from "@/lib/phase6-integration/mock-supabase";
import {
  persistCurriculumWithSources,
  mirrorToLegacy,
  type PersistCurriculumInput,
} from "../persistence";

// Use a mutable container so vi.mock factory always gets the current instance
const mockClientContainer = { current: new MockSupabaseClient() };

// Mock at top level as required by vitest
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => mockClientContainer.current),
}));

// Helper to get current mock client
function getMockClient(): MockSupabaseClient {
  return mockClientContainer.current;
}

describe("Curriculum Persistence (Phase 8)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClientContainer.current = new MockSupabaseClient();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function createMockCurriculumInput(overrides: Partial<PersistCurriculumInput> = {}): PersistCurriculumInput {
    return {
      curriculumId: "test-curriculum-id",
      title: "Test Curriculum",
      subject: "Test Subject",
      nodes: [],
      provenance: {
        source_type: "adapted",
        source_url: "https://example.com/curriculum",
        source_title: "Test Curriculum Source",
        source_author: "Test Author",
        source_institution: "Test Institution",
        verification_state: "verified",
        structure_match_info: {
          unitCount: 3,
          understandingCount: 6,
          wordCount: 1000,
          hasRecognizableStructure: true,
          evidence: "seed_import",
        },
        notes: "Test notes",
      },
      ...overrides,
    };
  }

  describe("persistCurriculumWithSources", () => {
    beforeEach(() => {
      // Pre-insert a curriculum record for mirrorToLegacy to update
      getMockClient().insert("curricula", {
        id: "test-curriculum-id",
        title: "Test Curriculum",
        subject: "Test Subject",
        source_type: "adapted",
        status: "draft",
        created_at: "2024-01-01T00:00:00.000Z",
      });
    });

    it("inserts provenance record and mirrors to legacy fields on success", async () => {
      const { persistCurriculumWithSources } = await import("../persistence");
      const input = createMockCurriculumInput();

      const result = await persistCurriculumWithSources(input);

      expect(result.curriculumId).toBe("test-curriculum-id");
      expect(result.sourceId).toBeDefined();

      // Check curriculum_sources was inserted
      const sources = getMockClient().getRows("curriculum_sources");
      expect(sources.length).toBe(1);
      expect(sources[0].curriculum_id).toBe("test-curriculum-id");
      expect(sources[0].source_type).toBe("adapted");
      expect(sources[0].verification_state).toBe("verified");

      // Check legacy fields were mirrored
      const curricula = getMockClient().getRows("curricula");
      expect(curricula.length).toBe(1);
      expect(curricula[0].id).toBe("test-curriculum-id");
      expect(curricula[0].source_type).toBe("adapted");
      expect(curricula[0].source_attribution).toBe("Test Institution — Test Curriculum Source — Test Author");
      expect(curricula[0].source_url).toBe("https://example.com/curriculum");
    });

    it("throws on provenance insert failure", async () => {
      const { persistCurriculumWithSources } = await import("../persistence");

      // Configure shared mock to fail on curriculum_sources insert
      getMockClient().shouldFailNext = true;
      getMockClient().failMessage = "Duplicate key violation";

      const input = createMockCurriculumInput();

      await expect(persistCurriculumWithSources(input)).rejects.toThrow("Duplicate key violation");
    });

    it("throws on legacy mirror failure after provenance insert", async () => {
      const { persistCurriculumWithSources } = await import("../persistence");

      // Configure shared mock to fail on curricula update
      getMockClient().shouldFailOnTable = "curricula";
      getMockClient().tableFailMessage = "Update failed";

      const input = createMockCurriculumInput();

      await expect(persistCurriculumWithSources(input)).rejects.toThrow("Update failed");

      // Verify provenance was still inserted
      const sources = getMockClient().getRows("curriculum_sources");
      expect(sources.length).toBe(1);
    });
  });

  describe("mirrorToLegacy", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      mockClientContainer.current = new MockSupabaseClient();
      // Pre-insert a curriculum record for mirrorToLegacy tests
      getMockClient().insert("curricula", {
        id: "test-curriculum-id",
        title: "Test Curriculum",
        subject: "Test Subject",
        source_type: "adapted",
        status: "draft",
        created_at: "2024-01-01T00:00:00.000Z",
      });
    });

    afterEach(() => {
      vi.clearAllMocks();
    });

    it("mirrors most recent provenance record to legacy fields", async () => {
      const { mirrorToLegacy } = await import("../persistence");
      const mockClient = getMockClient();

      // Pre-seed two provenance records for same curriculum
      const curriculumId = "test-curriculum-id";
      const olderSource = {
        id: "source-1",
        curriculum_id: curriculumId,
        source_type: "adapted",
        source_url: "https://old.example.com",
        source_title: "Old Title",
        source_author: "Old Author",
        source_institution: "Old Institution",
        verification_state: "verified",
        created_at: "2024-01-01T00:00:00.000Z",
        source_attribution: null,
      };
      const newerSource = {
        id: "source-2",
        curriculum_id: curriculumId,
        source_type: "human_written",
        source_url: "https://new.example.com",
        source_title: "New Title",
        source_author: "New Author",
        source_institution: "New Institution",
        verification_state: "verified",
        created_at: "2024-01-02T00:00:00.000Z",
        source_attribution: null,
      };

      mockClient.insert("curriculum_sources", olderSource);
      mockClient.insert("curriculum_sources", newerSource);

      await mirrorToLegacy(curriculumId);

      // Check legacy fields were updated with newer source
      const curricula = mockClient.getRows("curricula");
      expect(curricula.length).toBe(1);
      expect(curricula[0].source_type).toBe("adapted"); // human_written -> adapted
      expect(curricula[0].source_attribution).toBe("New Institution — New Title — New Author");
      expect(curricula[0].source_url).toBe("https://new.example.com");
    });

    it("throws when no provenance record exists for curriculum", async () => {
      const { mirrorToLegacy } = await import("../persistence");
      // Use empty mock client (already set in beforeEach) but with different curriculum ID

      await expect(mirrorToLegacy("non-existent-curriculum")).rejects.toThrow(
        "No provenance record found for curriculum non-existent-curriculum - cannot mirror to legacy fields"
      );
    });

    it("throws on query error", async () => {
      const { mirrorToLegacy } = await import("../persistence");
      const mockClient = getMockClient();
      // Pre-insert a provenance record so we get past the first query
      mockClient.insert("curriculum_sources", {
        id: "source-1",
        curriculum_id: "test-curriculum-id",
        source_type: "adapted",
        source_url: "https://example.com",
        source_title: "Test",
        source_author: "Test",
        source_institution: "Test",
        verification_state: "verified",
        created_at: "2024-01-01T00:00:00.000Z",
        source_attribution: null,
      });
      // Test update failure on curricula table
      mockClient.shouldFailOnTable = "curricula";
      mockClient.tableFailMessage = "Update failed";

      await expect(mirrorToLegacy("test-curriculum-id")).rejects.toThrow("Update failed");
    });

    it("uses UUID tie-break when created_at is identical", async () => {
      const { mirrorToLegacy } = await import("../persistence");
      const mockClient = getMockClient();

      const curriculumId = "test-curriculum-id";
      const sameTimestamp = "2024-01-01T00:00:00.000Z";

      // Two sources with same created_at - UUID tie-break should pick smaller UUID
      const sourceA = {
        id: "aaa-aaa-aaa",
        curriculum_id: curriculumId,
        source_type: "adapted",
        source_url: "https://a.example.com",
        source_title: "Title A",
        source_author: "Author A",
        source_institution: "Institution A",
        verification_state: "verified",
        created_at: sameTimestamp,
        source_attribution: null,
      };
      const sourceB = {
        id: "bbb-bbb-bbb",
        curriculum_id: curriculumId,
        source_type: "adapted",
        source_url: "https://b.example.com",
        source_title: "Title B",
        source_author: "Author B",
        source_institution: "Institution B",
        verification_state: "verified",
        created_at: sameTimestamp,
        source_attribution: null,
      };

      mockClient.insert("curriculum_sources", sourceA);
      mockClient.insert("curriculum_sources", sourceB);

      await mirrorToLegacy(curriculumId);

      // Should pick sourceA (smaller UUID)
      const curricula = mockClient.getRows("curricula");
      expect(curricula[0].source_attribution).toBe("Institution A — Title A — Author A");
      expect(curricula[0].source_url).toBe("https://a.example.com");
    });

    it("is idempotent - re-running produces same result", async () => {
      const { mirrorToLegacy } = await import("../persistence");
      const mockClient = getMockClient();

      const curriculumId = "test-curriculum-id";
      const source = {
        id: "source-1",
        curriculum_id: curriculumId,
        source_type: "adapted",
        source_url: "https://example.com",
        source_title: "Test Title",
        source_author: "Test Author",
        source_institution: "Test Institution",
        verification_state: "verified",
        created_at: "2024-01-01T00:00:00.000Z",
        source_attribution: null,
      };

      mockClient.insert("curriculum_sources", source);

      await mirrorToLegacy(curriculumId);
      await mirrorToLegacy(curriculumId); // Second call

      const curricula = mockClient.getRows("curricula");
      expect(curricula.length).toBe(1);
      expect(curricula[0].source_attribution).toBe("Test Institution — Test Title — Test Author");
    });
  });

  describe("formatAttribution (via mirrorToLegacy)", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      mockClientContainer.current = new MockSupabaseClient();
      // Pre-insert a curriculum record
      getMockClient().insert("curricula", {
        id: "test-curriculum-id",
        title: "Test Curriculum",
        subject: "Test Subject",
        source_type: "adapted",
        status: "draft",
        created_at: "2024-01-01T00:00:00.000Z",
      });
    });

    it("joins institution, title, author with ' — '", async () => {
      const { mirrorToLegacy } = await import("../persistence");
      const mockClient = getMockClient();

      const curriculumId = "test-curriculum-id";
      const source = {
        id: "source-1",
        curriculum_id: curriculumId,
        source_type: "adapted",
        source_url: "https://example.com/curriculum",
        source_title: "Test Curriculum Source",
        source_author: "Test Author",
        source_institution: "Test Institution",
        verification_state: "verified",
        created_at: "2024-01-01T00:00:00.000Z",
        source_attribution: null,
      };

      mockClient.insert("curriculum_sources", source);

      await mirrorToLegacy(curriculumId);

      const curricula = mockClient.getRows("curricula");
      expect(curricula[0].source_attribution).toBe("Test Institution — Test Curriculum Source — Test Author");
    });

    it("falls back to source_url when all attribution parts are null", async () => {
      const { mirrorToLegacy } = await import("../persistence");
      const mockClient = getMockClient();

      const curriculumId = "test-curriculum-id";
      const source = {
        id: "source-1",
        curriculum_id: curriculumId,
        source_type: "adapted",
        source_url: "https://example.com/fallback",
        source_title: null,
        source_author: null,
        source_institution: null,
        verification_state: "verified",
        created_at: "2024-01-01T00:00:00.000Z",
        source_attribution: null,
      };

      mockClient.insert("curriculum_sources", source);

      await mirrorToLegacy(curriculumId);

      const curricula = mockClient.getRows("curricula");
      expect(curricula[0].source_attribution).toBe("https://example.com/fallback");
    });

    it("falls back to 'Unknown source' when all fields null", async () => {
      const { mirrorToLegacy } = await import("../persistence");
      const mockClient = getMockClient();

      const curriculumId = "test-curriculum-id";
      const source = {
        id: "source-1",
        curriculum_id: curriculumId,
        source_type: "adapted",
        source_url: null,
        source_title: null,
        source_author: null,
        source_institution: null,
        verification_state: "verified",
        created_at: "2024-01-01T00:01:00.000Z",
        source_attribution: null,
      };

      mockClient.insert("curriculum_sources", source);

      await mirrorToLegacy(curriculumId);

      const curricula = mockClient.getRows("curricula");
      expect(curricula[0].source_attribution).toBe("Unknown source");
    });
  });
});