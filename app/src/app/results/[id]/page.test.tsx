import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const state = vi.hoisted(() => ({
  viewerProps: [] as unknown[],
  resources: [
    {
      id: "eligible-resource",
      node_id: "node-1",
      major_understanding_id: null,
      url: "https://public.example/eligible-resource",
      title: "Eligible approved resource",
      ai_note: "Eligible student note",
      status: "approved",
      content_type_verified: true,
    },
    {
      id: "draft-resource",
      node_id: "node-1",
      major_understanding_id: null,
      url: "https://private.invalid/draft-url-marker",
      title: "PRIVATE_DRAFT_TITLE_MARKER",
      ai_note: "PRIVATE_DRAFT_NOTE_MARKER",
      candidate_metadata: "PRIVATE_DRAFT_METADATA_MARKER",
      status: "draft",
      content_type_verified: true,
    },
    {
      id: "unverified-draft-resource",
      node_id: "node-1",
      major_understanding_id: null,
      url: "https://private.invalid/unverified-url-marker",
      title: "PRIVATE_UNVERIFIED_TITLE_MARKER",
      ai_note: "PRIVATE_UNVERIFIED_NOTE_MARKER",
      candidate_metadata: "PRIVATE_UNVERIFIED_METADATA_MARKER",
      status: "draft",
      content_type_verified: false,
    },
    {
      id: "rejected-resource",
      node_id: "node-1",
      major_understanding_id: null,
      url: "https://private.invalid/rejected-url-marker",
      title: "PRIVATE_REJECTED_TITLE_MARKER",
      ai_note: "PRIVATE_REJECTED_NOTE_MARKER",
      candidate_metadata: "PRIVATE_REJECTED_METADATA_MARKER",
      status: "rejected",
      content_type_verified: true,
    },
    {
      id: "approved-unverified-resource",
      node_id: "node-1",
      major_understanding_id: null,
      url: "https://private.invalid/approved-unverified-url-marker",
      title: "PRIVATE_APPROVED_UNVERIFIED_TITLE_MARKER",
      ai_note: "PRIVATE_APPROVED_UNVERIFIED_NOTE_MARKER",
      candidate_metadata: "PRIVATE_APPROVED_UNVERIFIED_METADATA_MARKER",
      status: "approved",
      content_type_verified: false,
    },
  ],
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: () => undefined })),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: null } })) },
  })),
}));

vi.mock("@/components/CurriculumHeader", () => ({ CurriculumHeader: () => null }));
vi.mock("@/components/CurriculumViewer", () => ({
  CurriculumViewer: (props: unknown) => {
    state.viewerProps.push(props);
    return null;
  },
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: (table: string) => {
      let inColumn: string | null = null;
      let inValues: string[] = [];
      const query: {
        select: () => typeof query;
        eq: () => typeof query;
        order: () => typeof query;
        limit: () => typeof query;
        in: (column: string, values: string[]) => typeof query;
        maybeSingle: () => Promise<{ data: unknown; error: null }>;
        then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => Promise<unknown>;
      } = {
        select: () => query,
        eq: () => query,
        order: () => query,
        limit: () => query,
        in: (column, values) => {
          inColumn = column;
          inValues = values;
          return query;
        },
        maybeSingle: async () => ({
          data: {
            id: "published-curriculum",
            title: "Published curriculum",
            subject: "Science",
            status: "published",
            created_by: null,
            source_type: "ai_organized",
            source_attribution: null,
            source_url: null,
          },
          error: null,
        }),
        then: (resolve, reject) => {
          const data = table === "nodes"
            ? [{
                id: "node-1",
                external_key: "topic-1",
                title: "Public topic",
                order_index: 1,
                major_understandings: [{ id: "mu-1", code: "MU1", description: "Public understanding", order_index: 1 }],
              }]
            : table === "resources"
              ? state.resources.filter((resource) =>
                  inColumn !== null && inValues.includes(resource[inColumn as "node_id" | "major_understanding_id"] ?? "")
                )
              : [];
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return query;
    },
  })),
}));

const { default: ResultsPage } = await import("./page");

describe("published results page resource serialization", () => {
  beforeEach(() => {
    state.viewerProps.length = 0;
    vi.clearAllMocks();
  });

  afterEach(() => {
    state.viewerProps.length = 0;
  });

  it("passes only approved, content-verified resources to the public viewer", async () => {
    const page = await ResultsPage({ params: Promise.resolve({ id: "published-curriculum" }) });
    const markup = renderToStaticMarkup(page);

    expect(state.viewerProps).toHaveLength(1);
    const props = state.viewerProps[0] as {
      resourcesByTarget: Record<string, Array<{ id: string; title: string; url: string; ai_note: string }>>;
      candidateResourcesByTarget: Record<string, unknown[]>;
    };
    expect(props.resourcesByTarget["node:node-1"].map((resource) => resource.id)).toEqual(["eligible-resource"]);
    expect(props.resourcesByTarget["node:node-1"][0]).toMatchObject({
      title: "Eligible approved resource",
      url: "https://public.example/eligible-resource",
      ai_note: "Eligible student note",
    });
    expect(props.candidateResourcesByTarget["node:node-1"]).toEqual([]);

    const serializedViewerProps = JSON.stringify(props);
    for (const marker of [
      "private.invalid",
      "PRIVATE_DRAFT_TITLE_MARKER",
      "PRIVATE_DRAFT_NOTE_MARKER",
      "PRIVATE_DRAFT_METADATA_MARKER",
      "PRIVATE_UNVERIFIED_TITLE_MARKER",
      "PRIVATE_UNVERIFIED_NOTE_MARKER",
      "PRIVATE_UNVERIFIED_METADATA_MARKER",
      "PRIVATE_REJECTED_TITLE_MARKER",
      "PRIVATE_REJECTED_NOTE_MARKER",
      "PRIVATE_REJECTED_METADATA_MARKER",
      "PRIVATE_APPROVED_UNVERIFIED_TITLE_MARKER",
      "PRIVATE_APPROVED_UNVERIFIED_NOTE_MARKER",
      "PRIVATE_APPROVED_UNVERIFIED_METADATA_MARKER",
    ]) {
      expect(serializedViewerProps).not.toContain(marker);
      expect(markup).not.toContain(marker);
    }
  });
});
