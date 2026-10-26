// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { GenerationResultResources } from "./GenerationResultResources";

describe("GenerationResultResources", () => {
  it("presents approved resources and valid candidates without exposing review labels", () => {
    render(<GenerationResultResources
      approved={[{ id: "approved", title: "Verified lesson", url: "https://example.org/approved" }]}
      candidates={[
        { id: "candidate", title: "Possible lesson", url: "https://example.org/candidate" },
        { id: "invalid", title: "Bad link", url: "javascript:alert(1)" },
      ]}
    />);

    expect(screen.getByRole("heading", { name: "Approved resources" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "More learning resources" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Verified lesson" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Possible lesson" })).toBeTruthy();
    expect(screen.queryByText(/not approved/i)).toBeNull();
    expect(screen.queryByRole("link", { name: "Bad link" })).toBeNull();
    expect(screen.queryByText(/verified candidate/i)).toBeNull();
    expect(screen.queryByText(/approved candidate/i)).toBeNull();
  });
});
