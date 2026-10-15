/**
 * Phase 8 Seed Search Provider
 * Deterministic curriculum candidate generator using seeded curriculum data.
 * Only returns candidates for the 6 known seed curricula - no guessing.
 */

import { SearchProvider, SearchOptions, DiscoveryCandidate, CandidateSource } from "./provider";

/** Known seed curriculum topics with their verified source URLs */
interface SeedCurriculumEntry {
  topicKey: string;
  title: string;
  subject: string;
  sourceUrls: string[];
  sourceDomain: string;
  sourceAttribution: string;
}

/** Static seed curriculum data - mirrors seed_curriculum.json and DB records */
const SEED_CURRICULA: SeedCurriculumEntry[] = [
  {
    topicKey: "amc 10/12 to aime preparation",
    title: "AMC 10/12 to AIME Preparation Curriculum",
    subject: "AMC",
    sourceUrls: [
      "https://maa.org/student-programs/amc/",
      "https://gonit.app/blog/amc-syllabus/"
    ],
    sourceDomain: "maa.org",
    sourceAttribution: "Mathematical Association of America (MAA) AMC Syllabus, Art of Problem Solving (AoPS) competition curriculum structure, and Gonit/Think Academy prep guides"
  },
  {
    topicKey: "amc 12 competition math",
    title: "AMC 12 Competition Math: Complete Curriculum",
    subject: "AMC 12 Competition Math",
    sourceUrls: [
      "https://maa.org/student-programs/amc/"
    ],
    sourceDomain: "maa.org",
    sourceAttribution: "Mathematical Association of America (MAA) AMC 12 syllabus, Art of Problem Solving curriculum structure, and multiple AMC prep guides"
  },
  {
    topicKey: "ap physics c",
    title: "AP Physics C: Calculus-Based Classical Physics",
    subject: "AP Physics C",
    sourceUrls: [
      "https://apcentral.collegeboard.org/courses/ap-physics-c-mechanics"
    ],
    sourceDomain: "apcentral.collegeboard.org",
    sourceAttribution: "College Board AP Physics C Course Framework (Mechanics and Electricity & Magnetism)"
  },
  {
    topicKey: "ap psychology",
    title: "AP Psychology: 1-Month Intensive Exam Preparation",
    subject: "AP Psychology",
    sourceUrls: [
      "https://apcentral.collegeboard.org/courses/ap-psychology"
    ],
    sourceDomain: "apcentral.collegeboard.org",
    sourceAttribution: "College Board AP Psychology Course and Exam Description (2024-2025 revision) - Five-Unit Framework aligned with American Psychological Association recommendations"
  },
  {
    topicKey: "usaco bronze",
    title: "USACO Bronze Competitive Programming Curriculum",
    subject: "USACO Bronze",
    sourceUrls: [
      "https://usaco.guide/bronze"
    ],
    sourceDomain: "usaco.guide",
    sourceAttribution: "USACO Guide (usaco.guide) - official community resource for USACO preparation"
  },
  {
    topicKey: "nysed chemistry",
    title: "NYS Regents Physical Setting/Chemistry (legacy 10-topic Core Curriculum)",
    subject: "chemistry",
    sourceUrls: [
      "https://www.nysed.gov/sites/default/files/programs/curriculum-instruction/chemist.pdf"
    ],
    sourceDomain: "nysed.gov",
    sourceAttribution: "NYSED Physical Setting/Chemistry Core Curriculum"
  }
];

/**
 * Deterministic seed curriculum search provider.
 * Only returns candidates for known seed curricula - no guessing or URL construction.
 */
export class SeedSearchProvider implements SearchProvider {
  async search(query: string, options?: SearchOptions): Promise<DiscoveryCandidate[]> {
    const normalizedQuery = query.trim().toLowerCase();
    const maxResults = options?.maxResults ?? 10;
    const domainFilter = options?.domainFilter;

    // Return empty for empty queries
    if (!normalizedQuery) {
      return [];
    }

    // Find matching seed curricula by topic key or title
    const matches = SEED_CURRICULA.filter(entry => {
      const topicMatch = entry.topicKey.includes(normalizedQuery) || normalizedQuery.includes(entry.topicKey);
      const titleMatch = entry.title.toLowerCase().includes(normalizedQuery);
      const subjectMatch = entry.subject.toLowerCase().includes(normalizedQuery);

      if (!topicMatch && !titleMatch && !subjectMatch) {
        return false;
      }

      if (domainFilter && domainFilter.length > 0) {
        return domainFilter.includes(entry.sourceDomain);
      }

      return true;
    });

    // Convert to DiscoveryCandidate format
    const candidates: DiscoveryCandidate[] = matches.flatMap(entry =>
      entry.sourceUrls.map(url => ({
        url,
        title: entry.title,
        sourceDomain: entry.sourceDomain,
        resourceType: "textbook" as const,
        aiNote: `Official curriculum source: ${entry.sourceAttribution}`,
        // Adding source property for audit trail (extends DiscoveryCandidate)
      }))
    ).slice(0, maxResults);

    // Add source property to each candidate (non-breaking extension)
    return candidates.map(c => ({ ...c, source: 'seed' as CandidateSource }));
  }
}

/**
 * Factory function to create the seed provider.
 * Allows for future extension with other $0-capable providers.
 */
export function createSeedSearchProvider(): SearchProvider {
  return new SeedSearchProvider();
}