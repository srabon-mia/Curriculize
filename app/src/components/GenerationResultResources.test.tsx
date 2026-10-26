// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { GenerationResultResources } from "./GenerationResultResources";

describe("GenerationResultResources", () => {
  it("separates approved resources from candidates and labels candidates as not approved", () => {
    render(<GenerationResultResources
      approved={[{ id: "approved", title: "Verified lesson", url: "https://example.org/approved" }]}
      candidates={[{ id: "candidate", title: "Possible lesson", url: "https://example.org/candidate" }]}
    />);

    expect(screen.getByRole("heading", { name: "Approved resources" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /Discovered candidates · Not approved/i })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Verified lesson" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Possible lesson" }).parentElement?.textContent).toMatch(/not approved/i);
    expect(screen.queryByText(/verified candidate/i)).toBeNull();
    expect(screen.queryByText(/approved candidate/i)).toBeNull();
  });
});
