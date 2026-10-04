/**
 * Tests for Anthropic Provider - Request Construction
 * Uses mocked fetch to avoid network calls.
 */

import { AnthropicProvider } from "../anthropic";
import { AIError } from "../types";

const originalFetch = global.fetch;

describe("AnthropicProvider", () => {
  let provider: AnthropicProvider;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn().mockResolvedValue(new Response());
    global.fetch = mockFetch as unknown as typeof fetch;
    provider = new AnthropicProvider({
      apiKey: "test-api-key",
      debug: false,
      retryDelayMs: 10, // Fast retry for testing
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.clearAllMocks();
  });

  interface MockResponseOverrides {
  status?: number;
  ok?: boolean;
  text?: string;
  json?: {
    id: string;
    type: string;
    role: string;
    content: Array<{ type: string; text?: string }>;
    model: string;
    stop_reason: string;
    stop_sequence: string | null;
    usage: { input_tokens: number; output_tokens: number };
  };
}

const createMockResponse = (overrides: Partial<MockResponseOverrides> = {}) => {
    const response = {
      status: overrides.status ?? 200,
      ok: overrides.ok ?? true,
      text: vi.fn().mockResolvedValue(overrides.text ?? ""),
      json: vi.fn().mockResolvedValue(overrides.json ?? {
        id: "msg_test",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: '{"result": "success"}' }],
        model: "claude-haiku-4-5-20251001",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    };
    return response;
  };

  test("constructs correct request for complete()", async () => {
    mockFetch.mockResolvedValue(createMockResponse());

    await provider.complete("Test prompt", { useSearch: false });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const call = mockFetch.mock.calls[0];
    expect(call[0]).toBe("https://api.anthropic.com/v1/messages");
    expect(call[1].method).toBe("POST");
    expect(call[1].headers["x-api-key"]).toBe("test-api-key");
    expect(call[1].headers["anthropic-version"]).toBe("2023-06-01");

    const body = JSON.parse(call[1].body as string);
    expect(body.model).toBe("claude-haiku-4-5-20251001");
    expect(body.max_tokens).toBe(4000);
    expect(body.messages).toEqual([{ role: "user", content: "Test prompt" }]);
    expect(body.tools).toBeUndefined();
  });

  test("includes web search tool when useSearch=true", async () => {
    mockFetch.mockResolvedValue(createMockResponse());

    await provider.complete("Test prompt", { useSearch: true });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.tools).toEqual([{ type: "web_search_20250305", name: "web_search" }]);
  });

  test("includes system prompt when provided", async () => {
    mockFetch.mockResolvedValue(createMockResponse());

    await provider.complete("Test prompt", { systemPrompt: "You are helpful" });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.system).toBe("You are helpful");
  });

  test("uses custom model and maxTokens", async () => {
    mockFetch.mockResolvedValue(createMockResponse());

    await provider.complete("Test prompt", { model: "custom-model", maxTokens: 1000 });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.model).toBe("custom-model");
    expect(body.max_tokens).toBe(1000);
  });

  test("returns extracted text on success", async () => {
    mockFetch.mockResolvedValue(createMockResponse({
      json: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Hello world" }],
        model: "claude-haiku-4-5-20251001",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 20 },
      },
    }));

    const result = await provider.complete("Test prompt");
    expect(result.text).toBe("Hello world");
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
  });

  test("handles rate limiting with retry", async () => {
    mockFetch
      .mockResolvedValueOnce(createMockResponse({ status: 429, ok: false, text: "Rate limited" }))
      .mockResolvedValueOnce(createMockResponse());

    const result = await provider.complete("Test prompt");
    expect(result.text).toBe('{"result": "success"}');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test("throws AIError on auth failure (401)", async () => {
    mockFetch.mockResolvedValue(createMockResponse({
      status: 401,
      ok: false,
      text: "Invalid API key",
    }));

    await expect(provider.complete("Test prompt")).rejects.toThrow(AIError);
    await expect(provider.complete("Test prompt")).rejects.toMatchObject({
      code: "AUTH_ERROR",
      statusCode: 401,
    });
  });

  test("throws AIError on invalid request (400)", async () => {
    mockFetch.mockResolvedValue(createMockResponse({
      status: 400,
      ok: false,
      text: "Bad request",
    }));

    await expect(provider.complete("Test prompt")).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      statusCode: 400,
    });
  });

  test("retries on server error (500)", async () => {
    mockFetch
      .mockResolvedValueOnce(createMockResponse({ status: 500, ok: false, text: "Server error" }))
      .mockResolvedValueOnce(createMockResponse());

    const result = await provider.complete("Test prompt");
    expect(result.text).toBe('{"result": "success"}');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test("throws after max retries exhausted", async () => {
    mockFetch.mockResolvedValue(createMockResponse({ status: 429, ok: false, text: "Rate limited" }));

    await expect(provider.complete("Test prompt")).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    expect(mockFetch).toHaveBeenCalledTimes(4); // default maxAttempts
  });

  test("extracts JSON from structured response", async () => {
    mockFetch.mockResolvedValue(createMockResponse({
      json: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: '{"name": "test", "value": 42}' }],
        model: "claude-haiku-4-5-20251001",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 20 },
      },
    }));

    // We can't easily test structured() without Zod, but we can test complete()
    const result = await provider.complete("Test prompt", { useSearch: false });
    expect(result.text).toContain("test");
    expect(result.text).toContain("42");
  });

  test("handles network errors", async () => {
    mockFetch.mockRejectedValue(new Error("Network error"));

    await expect(provider.complete("Test prompt")).rejects.toMatchObject({
      code: "NETWORK_ERROR",
    });
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });
});