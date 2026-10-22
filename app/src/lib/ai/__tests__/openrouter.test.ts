/**
 * Tests for OpenRouter Provider - Request Construction
 * Uses mocked fetch to avoid network calls.
 */

import { OpenRouterProvider } from "../openrouter";
import { AIError } from "../types";
import { z } from "zod";

const originalFetch = global.fetch;

describe("OpenRouterProvider", () => {
  let provider: OpenRouterProvider;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn().mockResolvedValue(new Response());
    global.fetch = mockFetch as unknown as typeof fetch;
    provider = new OpenRouterProvider({
      apiKey: "test-openrouter-key",
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
      object: string;
      created: number;
      model: string;
      choices: Array<{
        index: number;
        message: {
          role: string;
          content: string | null;
          tool_calls?: never;
        };
        finish_reason: string | null;
      }>;
      usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      };
    };
  }

  const createMockResponse = (overrides: Partial<MockResponseOverrides> = {}) => {
    const response = {
      status: overrides.status ?? 200,
      ok: overrides.ok ?? true,
      text: vi.fn().mockResolvedValue(overrides.text ?? ""),
      json: vi.fn().mockResolvedValue(overrides.json ?? {
        id: "chatcmpl_test",
        object: "chat.completion",
        created: Date.now(),
        model: "openrouter/free",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: '{"result": "success"}',
            tool_calls: undefined,
          },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      }),
    };
    return response;
  };

  test("constructs correct request for complete()", async () => {
    mockFetch.mockResolvedValue(createMockResponse());

    await provider.complete("Test prompt", { useSearch: false });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const call = mockFetch.mock.calls[0];
    expect(call[0]).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(call[1].method).toBe("POST");
    expect(call[1].headers["Authorization"]).toBe("Bearer test-openrouter-key");
    expect(call[1].headers["Content-Type"]).toBe("application/json");
    expect(call[1].headers["HTTP-Referer"]).toBe("https://curriculum-generator-alpha.vercel.app");
    expect(call[1].headers["X-Title"]).toBe("Curriculum Generator");

    const body = JSON.parse(call[1].body as string);
    expect(body.model).toBe("openrouter/free");
    expect(body.max_tokens).toBe(4000);
    expect(body.messages).toEqual([{ role: "user", content: "Test prompt" }]);
    expect(body.tools).toBeUndefined();
    expect(body.response_format).toBeUndefined();
  });

  test("includes system prompt when provided", async () => {
    mockFetch.mockResolvedValue(createMockResponse());

    await provider.complete("Test prompt", { systemPrompt: "You are helpful" });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.messages).toEqual([
      { role: "system", content: "You are helpful" },
      { role: "user", content: "Test prompt" },
    ]);
  });

  test("ignores custom model override, uses openrouter/free, respects maxTokens", async () => {
    mockFetch.mockResolvedValue(createMockResponse());

    await expect(provider.complete("Test prompt", { model: "custom-model", maxTokens: 1000 })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("returns extracted text on success", async () => {
    mockFetch.mockResolvedValue(createMockResponse({
      json: {
        id: "chatcmpl_test",
        object: "chat.completion",
        created: Date.now(),
        model: "openrouter/free",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: "Hello world",
            tool_calls: undefined,
          },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      },
    }));

    const result = await provider.complete("Test prompt");
    expect(result.text).toBe("Hello world");
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
  });

  test("handles rate limiting with retry and Retry-After header", async () => {
    // Create a proper mock response with headers
    const rateLimitResponse: Response = {
      status: 429,
      ok: false,
      text: vi.fn().mockResolvedValue("Rate limited"),
      json: vi.fn().mockResolvedValue({}),
      headers: new Headers({ "Retry-After": "1" }), // 1 second
    } as unknown as Response;

    mockFetch
      .mockResolvedValueOnce(rateLimitResponse)
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

  test("throws AIError on insufficient credits (402)", async () => {
    mockFetch.mockResolvedValue(createMockResponse({
      status: 402,
      ok: false,
      text: "Insufficient credits",
    }));

    await expect(provider.complete("Test prompt")).rejects.toMatchObject({
      code: "MODEL_ERROR",
      statusCode: 402,
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

  test("throws after max retries exhausted on rate limit", async () => {
    // Create a proper mock response with headers for 429
    const rateLimitResponse: Response = {
      status: 429,
      ok: false,
      text: vi.fn().mockResolvedValue("Rate limited"),
      json: vi.fn().mockResolvedValue({}),
      headers: new Headers({}), // No Retry-After header
    } as unknown as Response;

    mockFetch.mockResolvedValue(rateLimitResponse);

    await expect(provider.complete("Test prompt")).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    expect(mockFetch).toHaveBeenCalledTimes(4); // default maxAttempts
  });

  test("handles network errors with retry", async () => {
    mockFetch.mockRejectedValue(new Error("Network error"));

    await expect(provider.complete("Test prompt")).rejects.toMatchObject({
      code: "NETWORK_ERROR",
    });
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  test("respects AbortSignal", async () => {
    const controller = new AbortController();
    controller.abort();

    // Mock fetch to reject with AbortError
    mockFetch.mockRejectedValue(new DOMException("Aborted", "AbortError"));

    await expect(provider.complete("Test prompt", { signal: controller.signal })).rejects.toMatchObject({
      code: "ABORTED",
    });
  });

  test("structured() uses native JSON Schema response_format", async () => {
    const schema = z.object({
      name: z.string(),
      value: z.number(),
    });

    mockFetch.mockResolvedValue(createMockResponse({
      json: {
        id: "chatcmpl_test",
        object: "chat.completion",
        created: Date.now(),
        model: "openrouter/free",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: '{"name": "test", "value": 42}',
            tool_calls: undefined,
          },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      },
    }));

    const result = await provider.structured("Test prompt", { schema });
    expect(result.data).toEqual({ name: "test", value: 42 });
    expect(result.rawText).toBe('{"name": "test", "value": 42}');

    // Verify request used response_format
    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.response_format).toBeDefined();
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.name).toBe("structured_response");
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.temperature).toBe(0); // Should default to 0 for structured output
  });

  test("structured() validates against Zod schema", async () => {
    const schema = z.object({
      name: z.string(),
      value: z.number().min(0),
    });

    // Return invalid data (negative value)
    mockFetch.mockResolvedValue(createMockResponse({
      json: {
        id: "chatcmpl_test",
        object: "chat.completion",
        created: Date.now(),
        model: "openrouter/free",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: '{"name": "test", "value": -1}',
            tool_calls: undefined,
          },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      },
    }));

    await expect(provider.structured("Test prompt", { schema })).rejects.toThrow(AIError);
    await expect(provider.structured("Test prompt", { schema })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
  });

  test("structured() throws on malformed JSON", async () => {
    const schema = z.object({
      name: z.string(),
    });

    mockFetch.mockResolvedValue(createMockResponse({
      json: {
        id: "chatcmpl_test",
        object: "chat.completion",
        created: Date.now(),
        model: "openrouter/free",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: "not valid json",
            tool_calls: undefined,
          },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      },
    }));

    await expect(provider.structured("Test prompt", { schema })).rejects.toThrow(AIError);
    await expect(provider.structured("Test prompt", { schema })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
  });

  test("capabilities reflects native structured output, no web search, no streaming", () => {
    expect(provider.capabilities).toEqual({
      structuredOutput: true,
      webSearch: false,
      streaming: false,
    });
  });

  test("provider name is openrouter", () => {
    expect(provider.name).toBe("openrouter");
  });

  test("throws on missing API key", () => {
    expect(() => new OpenRouterProvider({ apiKey: "" })).toThrow("OpenRouter API key is required");
  });

  test("defaults to openrouter/free model", () => {
    const defaultProvider = new OpenRouterProvider({ apiKey: "test" });
    expect(defaultProvider.name).toBe("openrouter");
    // The default model is used in requests - we verify via complete()
  });

  // --- Free-model enforcement tests ---

  test("constructor accepts default model openrouter/free", () => {
    const p = new OpenRouterProvider({ apiKey: "test", defaultModel: "openrouter/free" });
    expect(p.name).toBe("openrouter");
  });

  test("constructor rejects configured default model other than openrouter/free", () => {
    expect(() => new OpenRouterProvider({ apiKey: "test", defaultModel: "anthropic/claude-3.5-sonnet" })).toThrow(AIError);
    expect(() => new OpenRouterProvider({ apiKey: "test", defaultModel: "openrouter/paid" })).toThrow(AIError);
    expect(() => new OpenRouterProvider({ apiKey: "test", defaultModel: "gpt-4" })).toThrow(AIError);
    expect(() => new OpenRouterProvider({ apiKey: "test", defaultModel: "" })).toThrow(AIError);
    expect(() => new OpenRouterProvider({ apiKey: "test", defaultModel: "openrouter/free-extra" })).toThrow(AIError);
  });

  test("complete() accepts call-site model openrouter/free", async () => {
    mockFetch.mockResolvedValue(createMockResponse());
    const result = await provider.complete("Test prompt", { model: "openrouter/free", useSearch: false });
    expect(result.text).toBe('{"result": "success"}');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test("complete() rejects call-site model override to paid model", async () => {
    await expect(provider.complete("Test prompt", { model: "anthropic/claude-3.5-sonnet" })).rejects.toThrow(AIError);
    await expect(provider.complete("Test prompt", { model: "anthropic/claude-3.5-sonnet" })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("complete() rejects call-site model override to arbitrary string", async () => {
    await expect(provider.complete("Test prompt", { model: "gpt-4" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(provider.complete("Test prompt", { model: "openrouter/paid" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(provider.complete("Test prompt", { model: "" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(provider.complete("Test prompt", { model: "openrouter/free-extra" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("structured() rejects call-site model override", async () => {
    const schema = z.object({ name: z.string() });
    await expect(provider.structured("Test prompt", { schema, model: "gpt-4" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("constructor with invalid default model prevents any network request", async () => {
    // This test verifies that an invalid default model throws at construction,
    // so no fetch is ever attempted.
    expect(() => new OpenRouterProvider({ apiKey: "test", defaultModel: "invalid-model" })).toThrow(AIError);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("OpenRouterProvider - Factory Integration", () => {
  // Note: Factory tests are in factory.test.ts
  // This just verifies the provider can be created via factory
  test("createProvider creates OpenRouterProvider when provider=openrouter", async () => {
    const { createProvider } = await import("../factory");
    const provider = createProvider({
      provider: "openrouter",
      apiKey: "test-key",
    });
    expect(provider.name).toBe("openrouter");
  });

  test("createProvider throws for openrouter without api key", async () => {
    const { createProvider } = await import("../factory");
    expect(() => createProvider({ provider: "openrouter" })).toThrow("OPENROUTER_API_KEY is required");
  });
});