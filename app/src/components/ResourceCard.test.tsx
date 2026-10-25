/** @vitest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ResourceCard } from "./ResourceCard";
import type { Resource } from "@/lib/curriculum-data";

describe("ResourceCard review actions", () => {
  it("lets an administrator explicitly keep a draft", () => {
    const onKeepDraft = vi.fn();
    const resource: Resource = {
      id: "resource-1",
      node_id: "topic-1",
      major_understanding_id: null,
      url: "https://example.edu/lesson",
      title: "Lesson",
      source_domain: "example.edu",
      resource_type: "text",
      license_status: "link_only",
      embed_allowed: false,
      ai_note: null,
      created_at: "2026-10-24T00:00:00Z",
      content_type_verified: true,
      status: "draft",
    };

    render(
      <ResourceCard
        resource={resource}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onKeepDraft={onKeepDraft}
        onDelete={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Keep as draft" }));
    expect(onKeepDraft).toHaveBeenCalledWith("resource-1");
  });
});
