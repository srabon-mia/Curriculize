/**
 * Tests for Mock AI Provider
 */

import { z } from "zod";
import { MockProvider, createMockProvider, MockResponse } from "../mock";
import { AIError } from "../types";

const TestSchema = z.object({
  name: z.string(),
  value: z.number(),
});

describe("MockProvider", () => {
  let provider: MockProvider;

  beforeEach(() => {
    provider = new MockProvider();
    // Set default structured response that matches TestSchema, preserve completeText
    provider.setDefaultResponse({
      completeText: '{"result": "mock response"}',
      structuredData: { name: "default", value: 123 },
      usage: { inputTokens: 100, outputTokens: 50 },
    });
  });

  test("returns default response for complete()", async () => {
    const result = await provider.complete("test prompt");
    expect(result.text).toBe('{"result": "mock response"}');
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
  });

  test("returns default response for structured() with parsed JSON", async () => {
    // Default mock response doesn't match TestSchema, so provide one that does
    provider.setDefaultResponse({
      structuredData: { name: "default", value: 123 },
      usage: { inputTokens: 100, outputTokens: 50 },
    });
    const result = await provider.structured("test prompt", { schema: TestSchema });
    expect(result.data).toEqual({ name: "default", value: 123 });
    expect(result.rawText).toBe('{"name":"default","value":123}');
  });

  test("uses custom response for exact prompt match", async () => {
    provider.setResponse("custom prompt", {
      completeText: "custom response",
      usage: { inputTokens: 50, outputTokens: 25 },
    });

    const result = await provider.complete("custom prompt");
    expect(result.text).toBe("custom response");
    expect(result.usage).toEqual({ inputTokens: 50, outputTokens: 25 });
  });

  test("uses custom structured data", async () => {
    provider.setResponse("structured prompt", {
      structuredData: { name: "test", value: 42 },
      usage: { inputTokens: 50, outputTokens: 25 },
    });

    const result = await provider.structured("structured prompt", { schema: TestSchema });
    expect(result.data).toEqual({ name: "test", value: 42 });
  });

  test("throws configured error", async () => {
    provider.setResponse("error prompt", {
      error: new AIError("RATE_LIMITED", "Test error", { retryable: true }),
    });

    await expect(provider.complete("error prompt")).rejects.toThrow("Test error");
  });

  test("records call history", async () => {
    await provider.complete("prompt 1");
    await provider.complete("prompt 2");
    await provider.structured("prompt 3", { schema: TestSchema });

    expect(provider.getCallCount()).toBe(3);
    const calls = provider.getCalls();
    expect(calls).toHaveLength(3);
    expect(calls[0].method).toBe("complete");
    expect(calls[0].prompt).toBe("prompt 1");
    expect(calls[2].method).toBe("structured");
    expect(calls[2].prompt).toBe("prompt 3");
  });

  test("wasCalledWith detects specific prompts", async () => {
    await provider.complete("specific prompt");
    await provider.complete("other prompt");

    expect(provider.wasCalledWith("specific prompt")).toBe(true);
    expect(provider.wasCalledWith("not called")).toBe(false);
  });

  test("getLastCall returns most recent call", async () => {
    await provider.complete("first");
    await provider.complete("last");

    const last = provider.getLastCall();
    expect(last?.prompt).toBe("last");
  });

  test("getCalls with predicate filters correctly", async () => {
    await provider.complete("complete 1");
    await provider.structured("structured 1", { schema: TestSchema });
    await provider.complete("complete 2");

    const completeCalls = provider.getCalls((c) => c.method === "complete");
    expect(completeCalls).toHaveLength(2);
  });

  test("reset clears history and responses", async () => {
    provider.setResponse("test", { completeText: "custom" });
    await provider.complete("test");

    provider.reset();

    expect(provider.getCallCount()).toBe(0);
    expect(provider.wasCalledWith("test")).toBe(false);
    const result = await provider.complete("test");
    expect(result.text).toBe('{"result": "mock response"}');
  });

  test("delay simulates async behavior", async () => {
    const start = Date.now();
    provider.setResponse("delayed", { completeText: "delayed", delayMs: 50 });
    await provider.complete("delayed");
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });

  test("createMockProvider initializes with fixtures", async () => {
    const provider = createMockProvider({
      "fixture 1": { completeText: "fixture 1 response" },
      "fixture 2": { structuredData: { name: "fixture", value: 1 } },
    });

    const result1 = await provider.complete("fixture 1");
    expect(result1.text).toBe("fixture 1 response");

    const result2 = await provider.structured("fixture 2", { schema: TestSchema });
    expect(result2.data).toEqual({ name: "fixture", value: 1 });
  });

  test("structured() validates against schema", async () => {
    provider.setResponse("invalid", {
      structuredData: { name: "test" }, // missing required 'value'
    });

    await expect(provider.structured("invalid", { schema: TestSchema })).rejects.toThrow();
  });

  test("capabilities are correct", () => {
    expect(provider.capabilities).toEqual({
      structuredOutput: true,
      webSearch: false,
      streaming: false,
    });
    expect(provider.name).toBe("mock");
  });
});