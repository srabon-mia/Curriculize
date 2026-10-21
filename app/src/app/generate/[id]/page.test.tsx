// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, act } from "@testing-library/react";
import { useRouter } from "next/navigation";
import GeneratePage from "./page";

// Mock next/navigation
vi.mock("next/navigation", () => ({
  useRouter: vi.fn(),
}));

// Mock EventSource globally - jsdom doesn't have it by default
const eventSourceInstances: Array<{
  url: string;
  addEventListener: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  readyState: number;
}> = [];

class MockEventSourceClass {
  url: string;
  addEventListener: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  readyState: number;

  constructor(url: string) {
    const instance = {
      addEventListener: vi.fn(),
      close: vi.fn(),
      readyState: 1, // EventSource.OPEN = 1
    };
    this.url = url;
    this.addEventListener = instance.addEventListener;
    this.close = instance.close;
    this.readyState = instance.readyState;
    eventSourceInstances.push(this);
  }
}

// Mock the global EventSource
vi.stubGlobal("EventSource", MockEventSourceClass);

// Mock next/navigation
vi.mock("next/navigation", () => ({
  useRouter: vi.fn(),
}));

// Mock use(params) to return a resolved ID
vi.mock("react", async () => {
  const actualReact = await vi.importActual("react");
  return {
    ...actualReact,
    use: vi.fn((promise: Promise<{ id: string }>) => {
      // Return the resolved value for testing
      return { id: "test-curriculum-id" };
    }),
  };
});

describe("GeneratePage - EventSource connection", () => {
  let mockRouter: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    eventSourceInstances.length = 0;
    mockRouter = { push: vi.fn() };
    (useRouter as ReturnType<typeof vi.fn>).mockReturnValue(mockRouter);
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("creates EventSource on initial mount with correct URL", async () => {
    const { unmount } = render(
      <GeneratePage params={Promise.resolve({ id: "test-curriculum-id" })} />
    );

    // Wait for EventSource to be constructed
    await waitFor(() => {
      expect(eventSourceInstances.length).toBe(1);
    });

    // Assert the EventSource was constructed with the correct URL
    expect(eventSourceInstances[0].url).toBe("/api/generate/test-curriculum-id/stream");

    unmount();
  });

  it("closes EventSource on unmount", async () => {
    const { unmount } = render(
      <GeneratePage params={Promise.resolve({ id: "test-curriculum-id" })} />
    );

    // Wait for EventSource to be constructed
    await waitFor(() => {
      expect(eventSourceInstances.length).toBe(1);
    });

    const instance = eventSourceInstances[0];
    expect(instance.close).not.toHaveBeenCalled();

    unmount();

    // Verify close was called on unmount
    expect(instance.close).toHaveBeenCalledTimes(1);
  });
});