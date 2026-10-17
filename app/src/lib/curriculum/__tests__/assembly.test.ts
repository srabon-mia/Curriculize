import { describe, it, expect } from "vitest";
import {
  selectEligibleResources,
  rankResourcesV1,
  type Resource,
} from "../../curriculum-data";

function mk(over: Partial<Resource>): Resource {
  return {
    id: "r1",
    node_id: null,
    major_understanding_id: null,
    url: "https://example.com/x",
    title: "T",
    source_domain: "nysed.gov",
    resource_type: "text",
    license_status: "link_only",
    embed_allowed: false,
    ai_note: null,
    status: "draft",
    created_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

describe("selectEligibleResources", () => {
  it("keeps only approved + verified", () => {
    const res = [
      mk({ id: "a", status: "approved", content_type_verified: true }),
      mk({ id: "b", status: "approved", content_type_verified: false }),
      mk({ id: "c", status: "draft", content_type_verified: true }),
      mk({ id: "d", status: "rejected", content_type_verified: true }),
    ];
    const out = selectEligibleResources(res);
    expect(out.map((r) => r.id)).toEqual(["a"]);
  });
});

describe("rankResourcesV1", () => {
  const ds = { "nysed.gov": 5, "openstax.org": 4, "random.com": 1 };

  it("correctly ranks by domain score descending", () => {
    const res: Resource[] = [
      { id: "low", node_id: null, major_understanding_id: null, url: "u", title: "L", source_domain: "random.com", resource_type: "text", license_status: "link_only", embed_allowed: false, ai_note: null, status: "approved", created_at: "t", content_type_verified: true },
      { id: "high", node_id: null, major_understanding_id: null, url: "u", title: "H", source_domain: "nysed.gov", resource_type: "text", license_status: "link_only", embed_allowed: false, ai_note: null, status: "approved", created_at: "t", content_type_verified: true },
      { id: "mid", node_id: null, major_understanding_id: null, url: "u", title: "M", source_domain: "openstax.org", resource_type: "text", license_status: "link_only", embed_allowed: false, ai_note: null, status: "approved", created_at: "t", content_type_verified: true },
    ];
    const got = rankResourcesV1(res, ds, {});
    expect(got.map((r) => r.id)).toEqual(["high", "mid", "low"]);
  });

  it("tiebreaks by fetched_at recency then stable order", () => {
    const now = "2026-10-10T00:00:00Z";
    const older = "2026-01-01T00:00:00Z";
    const res: Resource[] = [
      mk({ id: "newer", sourceDomain: "edu.org", status: "approved", content_type_verified: true, created_at: now }),
      mk({ id: "older", sourceDomain: "edu.org", status: "approved", content_type_verified: true, created_at: older }),
      mk({ id: "last", sourceDomain: "edu.org", status: "approved", content_type_verified: true, created_at: now }),
    ];
    // fetchedAt override: newer wins over older, last follows
    const fetchedAt: Record<string, string | null> = {
      older: older,
      newer: now,
      last: now,
    };
    const got = rankResourcesV1(res, {}, fetchedAt);
    expect(got.map((r) => r.id)).toEqual(["newer", "last", "older"]);
  });

  it("unscored domains default to 2 (conservative)", () => {
    const res: Resource[] = [
      { id: "scored", node_id: null, major_understanding_id: null, url: "u", title: "S", source_domain: "nysed.gov", resource_type: "text", license_status: "link_only", embed_allowed: false, ai_note: null, status: "approved", created_at: "t", content_type_verified: true },
      { id: "unscored", node_id: null, major_understanding_id: null, url: "u", title: "U", source_domain: "unknown.example", resource_type: "text", license_status: "link_only", embed_allowed: false, ai_note: null, status: "approved", created_at: "t", content_type_verified: true },
    ];
    const got = rankResourcesV1(res, {}, {});
    expect(got[0].id).toBe("scored");
  });

  it("returns a new array (no mutation)", () => {
    const res: Resource[] = [mk({ id: "a" })];
    const out = rankResourcesV1(res, {}, {});
    expect(out).not.toBe(res);
    expect(out).toHaveLength(1);
  });
});
