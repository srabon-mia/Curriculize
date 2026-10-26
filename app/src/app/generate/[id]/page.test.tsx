// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, act, fireEvent } from "@testing-library/react";
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
  listeners: Map<string, (event: Event) => void>;
}> = [];

class MockEventSourceClass {
  url: string;
  addEventListener: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  readyState: number;
  listeners: Map<string, (event: Event) => void>;

  constructor(url: string) {
    const listeners = new Map<string, (event: Event) => void>();
    const instance = {
      addEventListener: vi.fn((type: string, listener: (event: Event) => void) => listeners.set(type, listener)),
      close: vi.fn(),
      readyState: 1, // EventSource.OPEN = 1
      listeners,
    };
    this.url = url;
    this.addEventListener = instance.addEventListener;
    this.close = instance.close;
    this.readyState = instance.readyState;
    this.listeners = listeners;
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
    use: vi.fn(() => {
      // Return the resolved value for testing
      return { id: "test-curriculum-id" };
    }),
  };
});

describe("GeneratePage - EventSource connection", () => {
  let mockRouter: { push: ReturnType<typeof vi.fn> };

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

  it("keeps one connection when status events update the page", async () => {
    const { unmount } = render(
      <GeneratePage params={Promise.resolve({ id: "test-curriculum-id" })} />
    );
    await waitFor(() => expect(eventSourceInstances.length).toBe(1));

    act(() => {
      eventSourceInstances[0].listeners.get("status")?.({
        data: JSON.stringify({ message: "Finding structure…", step: "skeleton" }),
      } as MessageEvent);
    });
    await act(async () => Promise.resolve());

    expect(eventSourceInstances).toHaveLength(1);
    unmount();
  });

  it("stops after the finite transport retry limit", async () => {
    vi.useFakeTimers();
    const { getByText, unmount } = render(
      <GeneratePage params={Promise.resolve({ id: "test-curriculum-id" })} />
    );

    for (let attempt = 0; attempt < 5; attempt++) {
      const current = eventSourceInstances[eventSourceInstances.length - 1];
      act(() => current.listeners.get("error")?.({ data: undefined } as MessageEvent));
      if (attempt < 4) {
        await act(async () => vi.advanceTimersByTimeAsync(2000));
      }
    }

    expect(eventSourceInstances).toHaveLength(5);
    expect(getByText(/could not make progress after several attempts/i)).toBeTruthy();
    unmount();
    vi.useRealTimers();
  });

  it("reconnects once after the server yields a durable continuation", async () => {
    vi.useFakeTimers();
    const { unmount } = render(
      <GeneratePage params={Promise.resolve({ id: "test-curriculum-id" })} />
    );
    const first = eventSourceInstances[0];
    act(() => first.listeners.get("yielded")?.({
      data: JSON.stringify({ message: "Resuming…", topicsCompleted: 2, totalTopics: 4 }),
    } as MessageEvent));

    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(eventSourceInstances).toHaveLength(2);
    unmount();
    vi.useRealTimers();
  });

  it("continues through nine concept-batch yields and reports terminal insufficient coverage", async () => {
    vi.useFakeTimers();
    const { getByRole, queryByText, unmount } = render(
      <GeneratePage params={Promise.resolve({ id: "test-curriculum-id" })} />
    );

    for (let continuation = 0; continuation < 9; continuation++) {
      const current = eventSourceInstances[eventSourceInstances.length - 1];
      act(() => current.listeners.get("yielded")?.({
        data: JSON.stringify({ message: "Concept batch checkpointed", topicsCompleted: 1, totalTopics: 9 }),
      } as MessageEvent));
      expect(mockRouter.push).not.toHaveBeenCalled();
      if (continuation < 8) await act(async () => vi.advanceTimersByTimeAsync(2000));
    }

    expect(eventSourceInstances).toHaveLength(9);
    expect(queryByText(/retry limit was reached/i)).toBeNull();
    act(() => eventSourceInstances[8].listeners.get("complete")?.({
      data: JSON.stringify({ curriculum_id: "test-curriculum-id", phase: "background", coverage_status: "insufficient" }),
    } as MessageEvent));

    expect(getByRole("status").textContent).toMatch(/resource coverage is insufficient/i);
    expect(queryByText(/retry limit was reached/i)).toBeNull();
    expect(mockRouter.push).toHaveBeenCalledWith("/admin/curriculum/test-curriculum-id");
    expect(getByRole("link", { name: "View curriculum" }).getAttribute("href"))
      .toBe("/admin/curriculum/test-curriculum-id");
    unmount();
    vi.useRealTimers();
  });

  it("navigates to the curriculum only when terminal coverage is complete", async () => {
    const { getByRole, unmount } = render(
      <GeneratePage params={Promise.resolve({ id: "test-curriculum-id" })} />
    );
    const completed = {
      data: JSON.stringify({ curriculum_id: "persisted-curriculum-id", phase: "background", coverage_status: "complete" }),
    } as MessageEvent;
    act(() => eventSourceInstances[0].listeners.get("complete")?.(completed));
    act(() => eventSourceInstances[0].listeners.get("complete")?.(completed));

    expect(mockRouter.push).toHaveBeenCalledTimes(1);
    expect(mockRouter.push).toHaveBeenCalledWith("/curriculum/persisted-curriculum-id");
    expect(getByRole("link", { name: "View curriculum" }).getAttribute("href"))
      .toBe("/curriculum/persisted-curriculum-id");
    unmount();
  });

  it("does not navigate on failed, yielded, or nonterminal completion events", async () => {
    vi.useFakeTimers();
    const { unmount } = render(
      <GeneratePage params={Promise.resolve({ id: "test-curriculum-id" })} />
    );
    const first = eventSourceInstances[0];
    act(() => first.listeners.get("yielded")?.({
      data: JSON.stringify({ message: "Resuming…", topicsCompleted: 2, totalTopics: 4 }),
    } as MessageEvent));
    expect(mockRouter.push).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    const resumed = eventSourceInstances[1];
    act(() => resumed.listeners.get("complete")?.({
      data: JSON.stringify({ curriculum_id: "persisted-curriculum-id", phase: "topics", coverage_status: "pending" }),
    } as MessageEvent));
    act(() => resumed.listeners.get("error")?.({
      data: JSON.stringify({ message: "Generation failed" }),
    } as MessageEvent));

    expect(mockRouter.push).not.toHaveBeenCalled();
    unmount();
    vi.useRealTimers();
  });

  it("does not navigate or offer a curriculum link when final coverage is unconfirmed", async () => {
    const { queryByRole, getByRole, unmount } = render(
      <GeneratePage params={Promise.resolve({ id: "test-curriculum-id" })} />
    );
    act(() => eventSourceInstances[0].listeners.get("complete")?.({
      data: JSON.stringify({ curriculum_id: "persisted-curriculum-id", phase: "background", coverage_status: "pending" }),
    } as MessageEvent));

    expect(mockRouter.push).not.toHaveBeenCalled();
    expect(getByRole("status").textContent).toMatch(/could not be confirmed/i);
    expect(queryByRole("link", { name: "View curriculum" })).toBeNull();
    unmount();
  });

  it("does not exhaust retries while durable status is observable and reconnects after an observer window", async () => {
    vi.useFakeTimers();
    const { queryByText, unmount } = render(
      <GeneratePage params={Promise.resolve({ id: "test-curriculum-id" })} />
    );

    for (let attempt = 0; attempt < 4; attempt++) {
      act(() => eventSourceInstances[eventSourceInstances.length - 1].listeners.get("error")?.({ data: undefined } as MessageEvent));
      await act(async () => vi.advanceTimersByTimeAsync(2000));
    }
    act(() => eventSourceInstances[eventSourceInstances.length - 1].listeners.get("status")?.({
      data: JSON.stringify({ message: "Generation is still running", step: "running", job_id: "job-1" }),
    } as MessageEvent));
    act(() => eventSourceInstances[eventSourceInstances.length - 1].listeners.get("continue")?.({ data: "{}" } as MessageEvent));
    await act(async () => vi.advanceTimersByTimeAsync(1000));

    expect(eventSourceInstances).toHaveLength(6);
    expect(queryByText(/could not make progress after several attempts/i)).toBeNull();
    unmount();
    vi.useRealTimers();
  });

  it("keeps a finite limit when intentional continuations repeat without progress", async () => {
    vi.useFakeTimers();
    const { getByText, unmount } = render(
      <GeneratePage params={Promise.resolve({ id: "test-curriculum-id" })} />
    );

    for (let attempt = 0; attempt < 60; attempt++) {
      const current = eventSourceInstances[eventSourceInstances.length - 1];
      act(() => current.listeners.get("status")?.({
        data: JSON.stringify({ message: "Finding resources", step: "discovery", current: 3, total: 9 }),
      } as MessageEvent));
      act(() => current.listeners.get("yielded")?.({
        data: JSON.stringify({ message: "Retrying topic", topicsCompleted: 0, totalTopics: 9 }),
      } as MessageEvent));
      if (attempt < 59) await act(async () => vi.advanceTimersByTimeAsync(2000));
    }

    expect(eventSourceInstances).toHaveLength(60);
    expect(getByText(/retry limit was reached/i)).toBeTruthy();
    unmount();
    vi.useRealTimers();
  });

  it("pauses a failed discovery without reconnecting until the user retries", async () => {
    const { getByText, unmount } = render(
      <GeneratePage params={Promise.resolve({ id: "test-curriculum-id" })} />
    );
    act(() => eventSourceInstances[0].listeners.get("paused")?.({
      data: JSON.stringify({ message: "Resource discovery paused with progress saved." }),
    } as MessageEvent));

    expect(getByText(/progress saved/i)).toBeTruthy();
    expect(eventSourceInstances).toHaveLength(1);
    fireEvent.click(getByText("Retry saved generation"));
    await waitFor(() => expect(eventSourceInstances).toHaveLength(2));
    unmount();
  });

  it("treats an observer timeout as a terminal pause instead of reconnecting automatically", async () => {
    vi.useFakeTimers();
    const { getByText, unmount } = render(
      <GeneratePage params={Promise.resolve({ id: "test-curriculum-id" })} />
    );
    const observer = eventSourceInstances[0];
    act(() => observer.listeners.get("paused")?.({
      data: JSON.stringify({ message: "Generation is still in progress. This page stopped waiting." }),
    } as MessageEvent));

    expect(getByText(/still in progress\. this page stopped waiting/i)).toBeTruthy();
    expect(observer.close).toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(eventSourceInstances).toHaveLength(1);
    unmount();
    vi.useRealTimers();
  });
});
