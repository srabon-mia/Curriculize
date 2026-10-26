// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { CurriculumHeader } from "./CurriculumHeader";

describe("CurriculumHeader", () => {
  it("renders the published viewer navigation, category, and linked source attribution", () => {
    render(<CurriculumHeader
      title="Arduino Fundamentals"
      subject="Electronics"
      source_attribution="University Example — Embedded Systems Syllabus"
      source_url="https://engineering.example.edu/courses/embedded-systems"
    />);

    expect(screen.getByRole("link", { name: /Browse Guides/ }).getAttribute("href")).toBe("/curriculum");
    expect(screen.getByText("Arduino Fundamentals")).toBeTruthy();
    expect(screen.getByText("Electronics")).toBeTruthy();
    expect(screen.getByRole("link", { name: /University Example — Embedded Systems Syllabus/ }).getAttribute("href"))
      .toBe("https://engineering.example.edu/courses/embedded-systems");
  });

  it("does not make malformed or non-HTTP source URLs clickable", () => {
    render(<CurriculumHeader title="Course" subject="Science" source_attribution="Source title" source_url="javascript:alert(1)" />);
    expect(screen.getByText("Source title").tagName).toBe("SPAN");
  });

  it("makes missing verified source provenance explicit for an AI-organized structure", () => {
    render(<CurriculumHeader title="Course" subject="Science" source_type="ai_organized" />);
    expect(screen.getByText("AI-organized structure · no human source verified")).toBeTruthy();
  });
});
