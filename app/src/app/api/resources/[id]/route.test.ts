import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireAdminApi: vi.fn() }));

vi.mock("@/lib/auth", () => ({ requireAdminApi: mocks.requireAdminApi }));

import { PATCH } from "./route";

describe("PATCH /api/resources/[id] review decisions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("records an intentional draft decision with the administrator identity", async () => {
    const selectedResource = { id: "resource-1", status: "draft", status_reviewed_by: "admin-1" };
    const query = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: selectedResource, error: null }),
    };
    const supabase = { from: vi.fn(() => query) };
    mocks.requireAdminApi.mockResolvedValue({ user: { id: "admin-1" }, supabase });

    const response = await PATCH(
      new Request("http://localhost/api/resources/resource-1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "draft" }),
      }),
      { params: Promise.resolve({ id: "resource-1" }) }
    );

    expect(response.status).toBe(200);
    expect(query.update).toHaveBeenCalledWith({ status: "draft", status_reviewed_by: "admin-1" });
    expect(query.eq).toHaveBeenCalledWith("id", "resource-1");
  });
});
