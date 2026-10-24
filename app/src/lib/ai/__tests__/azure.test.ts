/**
 * Tests for Azure Provider - Request Construction
 * Uses mocked fetch to avoid network calls.
 */

import { AzureProvider } from "../azure";
import { AIError } from "../types";
import { CandidateArraySchema, SourcesArraySchema } from "../../acquisition/discoverySchemas";
import { z } from "zod";

const originalFetch = global.fetch;

describe("AzureProvider", () => {
  let provider: AzureProvider;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn().mockResolvedValue(new Response());
    global.fetch = mockFetch as unknown as typeof fetch;
    provider = new AzureProvider({
      apiKey: "test-azure-key",
      endpoint: "https://test-resource.openai.azure.com",
      deployment: "gpt-4.1-mini",
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
        model: "gpt-4.1-mini",
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

  const createMockResponsesResponse = (overrides: Partial<{
    status: number;
    ok: boolean;
    text: string;
    json: {
      id: string;
      object: string;
      created_at: number;
      model: string;
      output: Array<{
        type: "message" | "web_search_call";
        role?: string;
        content?: Array<{
          type: "output_text";
          text: string;
          annotations?: Array<{
            type: "url_citation";
            url: string;
            title?: string;
            start_index: number;
            end_index: number;
          }>;
        }>;
        id?: string;
        status?: "completed" | "in_progress" | "failed";
        query?: string;
        action?: { type: "search"; query: string; sources?: Array<{ type?: string; url?: string }> };
      }>;
      usage?: { input_tokens: number; output_tokens: number; total_tokens: number };
    };
  }> = {}) => {
    const response = {
      status: overrides.status ?? 200,
      ok: overrides.ok ?? true,
      text: vi.fn().mockResolvedValue(overrides.text ?? ""),
      json: vi.fn().mockResolvedValue(overrides.json ?? {
        id: "resp_test",
        object: "response",
        created_at: Date.now(),
        model: "gpt-4.1-mini",
        output: [
          { type: "message", role: "assistant", content: [{ type: "output_text", text: '{"result": "success"}' }] }
        ],
        usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
      }),
    };
    return response;
  };

  test("constructs correct request for complete() with deployment-specific URL", async () => {
    mockFetch.mockResolvedValue(createMockResponse());

    await provider.complete("Test prompt", { useSearch: false });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const call = mockFetch.mock.calls[0];
    // Should use deployment-specific URL format
    expect(call[0]).toBe("https://test-resource.openai.azure.com/openai/deployments/gpt-4.1-mini/chat/completions?api-version=2024-12-01-preview");
    expect(call[1].method).toBe("POST");
    expect(call[1].headers["api-key"]).toBe("test-azure-key"); // Azure uses api-key header
    expect(call[1].headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(call[1].body as string);
    // Deployment-specific URL doesn't need model in body
    expect(body.model).toBeUndefined();
    expect(body.max_tokens).toBe(4000);
    expect(body.messages).toEqual([{ role: "user", content: "Test prompt" }]);
    expect(body.response_format).toBeUndefined();
  });

  test("constructs correct request for /openai/v1 endpoint when useV1Endpoint=true", async () => {
    const v1Provider = new AzureProvider({
      apiKey: "test-azure-key",
      endpoint: "https://test-resource.services.ai.azure.com/openai/v1",
      deployment: "gpt-4.1-mini",
      useV1Endpoint: true,
      debug: false,
      retryDelayMs: 10,
    });

    mockFetch.mockResolvedValue(createMockResponse());

    await v1Provider.complete("Test prompt", { useSearch: false });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const call = mockFetch.mock.calls[0];
    // Should use v1 endpoint format WITHOUT legacy api-version parameter
    expect(call[0]).toBe("https://test-resource.services.ai.azure.com/openai/v1/chat/completions");
    expect(call[0]).not.toContain("api-version");

    const body = JSON.parse(call[1].body as string);
    // v1 endpoint requires model in body
    expect(body.model).toBe("gpt-4.1-mini");
    expect(body.max_tokens).toBe(4000);
    expect(body.messages).toEqual([{ role: "user", content: "Test prompt" }]);
  });

  test("constructs correct Responses API URL for v1 endpoint", async () => {
    const v1Provider = new AzureProvider({
      apiKey: "test-azure-key",
      endpoint: "https://test-resource.services.ai.azure.com/openai/v1",
      deployment: "gpt-4.1-mini",
      useV1Endpoint: true,
      debug: false,
      retryDelayMs: 10,
    });
    mockFetch.mockImplementation(() => Promise.resolve(createMockResponsesResponse({
      json: {
        id: "resp_test",
        object: "response",
        created_at: Date.now(),
        model: "gpt-4.1-mini",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{
              type: "output_text",
              text: "Search results...",
              annotations: [{ type: "url_citation", url: "https://example.com", title: "Example", start_index: 0, end_index: 20 }]
            }]
          },
          {
            type: "web_search_call",
            id: "ws_1",
            status: "completed",
            query: "test query"
          }
        ],
        usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
      },
    })));

    await v1Provider.complete("Test prompt", { useSearch: true });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const call = mockFetch.mock.calls[0];
    // Should use v1 Responses API endpoint WITHOUT legacy api-version parameter
    expect(call[0]).toBe("https://test-resource.services.ai.azure.com/openai/v1/responses");
    expect(call[0]).not.toContain("api-version");

    const body = JSON.parse(call[1].body as string);
    // v1 Responses API requires model in body
    expect(body.model).toBe("gpt-4.1-mini");
    expect(body.tools).toEqual([{ type: "web_search" }]);
    expect(body.tool_choice).toBe("required");
  });

  test("legacy endpoint still uses deployment path with api-version", async () => {
    const legacyProvider = new AzureProvider({
      apiKey: "test-azure-key",
      endpoint: "https://test-resource.openai.azure.com",
      deployment: "gpt-4.1-mini",
      useV1Endpoint: false,
      debug: false,
      retryDelayMs: 10,
    });
    mockFetch.mockResolvedValue(createMockResponse());

    await legacyProvider.complete("Test prompt", { useSearch: false });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const call = mockFetch.mock.calls[0];
    // Legacy endpoint uses deployment path with api-version
    expect(call[0]).toBe("https://test-resource.openai.azure.com/openai/deployments/gpt-4.1-mini/chat/completions?api-version=2024-12-01-preview");
    expect(call[0]).toContain("api-version=2024-12-01-preview");
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

  test("uses custom maxTokens and temperature", async () => {
    mockFetch.mockResolvedValue(createMockResponse());

    await provider.complete("Test prompt", { maxTokens: 1000, temperature: 0.5 });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.max_tokens).toBe(1000);
    expect(body.temperature).toBe(0.5);
  });

  test("uses Responses API with web search when useSearch=true", async () => {
    const debugProvider = new AzureProvider({
      apiKey: "test-azure-key",
      endpoint: "https://test-resource.openai.azure.com",
      deployment: "gpt-4.1-mini",
      debug: true,
      retryDelayMs: 10,
    });
    mockFetch.mockImplementation(() => Promise.resolve(createMockResponsesResponse({
      json: {
        id: "resp_test",
        object: "response",
        created_at: Date.now(),
        model: "gpt-4.1-mini",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{
              type: "output_text",
              text: "Search results show...",
              annotations: [{
                type: "url_citation",
                url: "https://example.com",
                title: "Example",
                start_index: 0,
                end_index: 20
              }]
            }]
          },
          {
            type: "web_search_call",
            id: "ws_1",
            status: "completed",
            query: "test query"
          }
        ],
        usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
      },
    })));

    const result = await debugProvider.complete("Test prompt", { useSearch: true });

    // Verify it called the Responses API endpoint
    expect(mockFetch.mock.calls[0][0]).toContain("/responses");

    expect(result.text).toBe("Search results show...");
    expect(result.searchCitations).toBeDefined();
    expect(result.searchCitations!.length).toBe(1);
    expect(result.searchCitations![0].url).toBe("https://example.com");
    expect(result.searchCitations![0].title).toBe("Example");
    // snippet not available in url_citation annotation
    expect(result.searchCitations![0].snippet).toBeUndefined();
  });

  test("uses chat completions when useSearch=false", async () => {
    mockFetch.mockImplementation(() => Promise.resolve(createMockResponse()));

    const result = await provider.complete("Test prompt", { useSearch: false });

    expect(result.text).toBe('{"result": "success"}');
    expect(result.searchCitations).toBeUndefined();
    // Verify it called the chat completions endpoint
    expect(mockFetch.mock.calls[0][0]).toContain("/openai/deployments/");
  });

  test("returns searchCitations from annotations when search completes", async () => {
    const debugProvider = new AzureProvider({
      apiKey: "test-azure-key",
      endpoint: "https://test-resource.openai.azure.com",
      deployment: "gpt-4.1-mini",
      debug: true,
      retryDelayMs: 10,
    });
    mockFetch.mockImplementation(() => Promise.resolve(createMockResponsesResponse({
      json: {
        id: "resp_test",
        object: "response",
        created_at: Date.now(),
        model: "gpt-4.1-mini",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{
              type: "output_text",
              text: "Found resources at https://site1.com and https://site2.com",
              annotations: [
                { type: "url_citation", url: "https://site1.com", title: "Site 1", start_index: 18, end_index: 35 },
                { type: "url_citation", url: "https://site2.com", title: "Site 2", start_index: 40, end_index: 57 }
              ]
            }]
          },
          {
            type: "web_search_call",
            id: "ws_1",
            status: "completed",
            query: "educational resources"
          }
        ],
        usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
      },
    })));

    const result = await debugProvider.complete("Test prompt", { useSearch: true });

    expect(result.searchCitations).toBeDefined();
    expect(result.searchCitations!.length).toBe(2);
    expect(result.searchCitations![0].url).toBe("https://site1.com");
    expect(result.searchCitations![0].title).toBe("Site 1");
    expect(result.searchCitations![1].url).toBe("https://site2.com");
    expect(result.searchCitations![1].title).toBe("Site 2");
  });

  test("handles failed web search call", async () => {
    const debugProvider = new AzureProvider({
      apiKey: "test-azure-key",
      endpoint: "https://test-resource.openai.azure.com",
      deployment: "gpt-4.1-mini",
      debug: true,
      retryDelayMs: 10,
    });
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFetch.mockImplementation(() => Promise.resolve(createMockResponsesResponse({
      json: {
        id: "resp_test",
        object: "response",
        created_at: Date.now(),
        model: "gpt-4.1-mini",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Search failed, using training data" }]
          },
          {
            type: "web_search_call",
            id: "ws_1",
            status: "failed",
            query: "test query"
          }
        ],
        usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
      },
    })));

    const result = await debugProvider.complete("Test prompt", { useSearch: true });

    // Response still returned but search didn't complete
    expect(result.text).toBe("Search failed, using training data");
    expect(result.searchCitations).toBeUndefined();
    expect(consoleWarn).toHaveBeenCalledWith("[Azure] Web search call failed", { query: "test query", id: "ws_1" });
    consoleWarn.mockRestore();
  });

  test("handles in-progress web search call", async () => {
    const debugProvider = new AzureProvider({
      apiKey: "test-azure-key",
      endpoint: "https://test-resource.openai.azure.com",
      deployment: "gpt-4.1-mini",
      debug: true,
      retryDelayMs: 10,
    });
    mockFetch.mockImplementation(() => Promise.resolve(createMockResponsesResponse({
      json: {
        id: "resp_test",
        object: "response",
        created_at: Date.now(),
        model: "gpt-4.1-mini",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Search in progress..." }]
          },
          {
            type: "web_search_call",
            id: "ws_1",
            status: "in_progress",
            query: "test query"
          }
        ],
        usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
      },
    })));

    const result = await debugProvider.complete("Test prompt", { useSearch: true });

    // Response returned but search not completed
    expect(result.text).toBe("Search in progress...");
    expect(result.searchCitations).toBeUndefined();
  });

  test("returns extracted text on success", async () => {
    mockFetch.mockResolvedValue(createMockResponse({
      json: {
        id: "chatcmpl_test",
        object: "chat.completion",
        created: Date.now(),
        model: "gpt-4.1-mini",
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

  test("returns usage metadata", async () => {
    mockFetch.mockResolvedValue(createMockResponse({
      json: {
        id: "chatcmpl_test",
        object: "chat.completion",
        created: Date.now(),
        model: "gpt-4.1-mini",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: "Test response",
            tool_calls: undefined,
          },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 150, completion_tokens: 75, total_tokens: 225 },
      },
    }));

    const result = await provider.complete("Test prompt");
    expect(result.usage).toEqual({ inputTokens: 150, outputTokens: 75 });
  });

  test("detects empty response content", async () => {
    const debugProvider = new AzureProvider({
      apiKey: "test-azure-key",
      endpoint: "https://test-resource.openai.azure.com",
      deployment: "gpt-4.1-mini",
      debug: true,
      retryDelayMs: 10,
    });
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFetch.mockResolvedValue(createMockResponse({
      json: {
        id: "chatcmpl_test",
        object: "chat.completion",
        created: Date.now(),
        model: "gpt-4.1-mini",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: "", // Empty content
            tool_calls: undefined,
          },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
      },
    }));

    const result = await debugProvider.complete("Test prompt");
    expect(result.text).toBe("");
    expect(result.usage?.outputTokens).toBe(0);
    expect(consoleWarn).toHaveBeenCalledWith("[Azure] Empty response content received", { finish_reason: "stop" });
    consoleWarn.mockRestore();
  });

  test("does not log raw Responses API output when search text is empty", async () => {
    const debugProvider = new AzureProvider({
      apiKey: "test-azure-key",
      endpoint: "https://test-resource.openai.azure.com",
      deployment: "gpt-4.1-mini",
      debug: true,
      retryDelayMs: 10,
    });
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const privateResponseText = "private provider response payload";
    mockFetch.mockResolvedValue(createMockResponsesResponse({
      json: {
        id: "resp_test",
        object: "response",
        created_at: Date.now(),
        model: "gpt-4.1-mini",
        output: [
          { type: "web_search_call", status: "completed", action: { type: "search", query: "private query" } },
          { type: "message", role: "assistant", content: [{
            type: "output_text",
            text: "",
            annotations: [{ type: "url_citation", url: "https://example.org", title: privateResponseText, start_index: 0, end_index: 0 }],
          }] },
        ],
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    }));

    await debugProvider.complete("private prompt", { useSearch: true });

    expect(consoleWarn).toHaveBeenCalledWith("[Azure] Empty response content received", {
      response_item_types: ["web_search_call", "message"],
      search_call_statuses: ["completed"],
    });
    expect(JSON.stringify(consoleWarn.mock.calls)).not.toContain(privateResponseText);
    expect(JSON.stringify(consoleWarn.mock.calls)).not.toContain("private prompt");
    consoleWarn.mockRestore();
  });

  test("handles rate limiting with retry and Retry-After header", async () => {
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

  test("respects timeoutMs option via AbortSignal", async () => {
    // Mock fetch to simulate timeout
    mockFetch.mockImplementation(() => new Promise((_, reject) => {
      setTimeout(() => reject(new DOMException("Aborted", "AbortError")), 100);
    }));

    await expect(provider.complete("Test prompt", { timeoutMs: 50 })).rejects.toMatchObject({
      code: "ABORTED",
    });
  });

  test("structured() uses native JSON Schema response_format", async () => {
    const controller = new AbortController();
    const schema = z.object({
      name: z.string(),
      value: z.number(),
    });

    mockFetch.mockResolvedValue(createMockResponse({
      json: {
        id: "chatcmpl_test",
        object: "chat.completion",
        created: Date.now(),
        model: "gpt-4.1-mini",
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

    const result = await provider.structured("Test prompt", { schema, signal: controller.signal });
    expect(result.data).toEqual({ name: "test", value: 42 });
    expect(result.rawText).toBe('{"name": "test", "value": 42}');

    // Verify request used response_format
    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.response_format).toBeDefined();
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.name).toBe("structured_response");
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.response_format.json_schema.schema).toMatchObject({ type: "object", required: ["name", "value"] });
    expect(body.response_format.json_schema.schema.properties.items).toBeUndefined();
    expect(body.temperature).toBe(0); // Should default to 0 for structured output
    expect(mockFetch.mock.calls[0][1].signal).toBe(controller.signal);
  });

  test("source discovery wraps its actual root-array schema and unwraps validated items", async () => {
    const source = { domain: "khanacademy.org", name: "Khan Academy", why: "Clear lessons", best_for: "Foundations" };
    mockFetch.mockResolvedValueOnce(createMockResponse({
      json: {
        id: "chatcmpl_source_discovery",
        object: "chat.completion",
        created: Date.now(),
        model: "gpt-4.1-mini",
        choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ items: [source] }) }, finish_reason: "stop" }],
      },
    }));

    const result = await provider.structured("Find source platforms", { schema: SourcesArraySchema });
    const request = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    const responseSchema = request.response_format.json_schema.schema;

    expect(responseSchema).toMatchObject({ type: "object", required: ["items"], additionalProperties: false });
    expect(responseSchema.properties.items.type).toBe("array");
    expect(JSON.stringify(responseSchema)).not.toMatch(/"(?:format|minLength|maxLength|pattern)"/);
    expect(result.data).toEqual([source]);
  });

  test("source discovery rejects malformed wrapped array items", async () => {
    mockFetch.mockResolvedValueOnce(createMockResponse({
      json: {
        id: "chatcmpl_bad_source_discovery",
        object: "chat.completion",
        created: Date.now(),
        model: "gpt-4.1-mini",
        choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ items: [{ domain: "example.org" }] }) }, finish_reason: "stop" }],
      },
    }));

    await expect(provider.structured("Find source platforms", { schema: SourcesArraySchema })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  test.each([
    ["missing items", { other: [] }],
    ["unexpected wrapper property", { items: [], extra: true }],
  ])("rejects a malformed root-array wrapper (%s)", async (_caseName, malformedWrapper) => {
    mockFetch.mockResolvedValueOnce(createMockResponse({
      json: {
        id: "chatcmpl_malformed_array_wrapper",
        object: "chat.completion",
        created: Date.now(),
        model: "gpt-4.1-mini",
        choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(malformedWrapper) }, finish_reason: "stop" }],
      },
    }));

    await expect(provider.structured("Find source platforms", { schema: SourcesArraySchema })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  test("topic discovery wraps its actual root-array schema while preserving web search citations", async () => {
    const candidate = {
      url: "https://www.khanacademy.org/math/geometry",
      title: "Geometry",
      resource_type: "text",
      source_domain: "khanacademy.org",
      ai_note: "Introduces core geometry concepts",
      license_status: "link_only",
    };
    mockFetch
      .mockResolvedValueOnce(createMockResponsesResponse({
        json: {
          id: "resp_topic_search",
          object: "response",
          created_at: Date.now(),
          model: "gpt-4.1-mini",
          output: [
            { type: "web_search_call", status: "completed", action: { type: "search", query: "geometry", sources: [{ type: "url", url: "https://www.khanacademy.org/math/geometry" }] } },
            { type: "message", role: "assistant", content: [{ type: "output_text", text: "Relevant geometry resource." }] },
          ],
        },
      }))
      .mockResolvedValueOnce(createMockResponse({
        json: {
          id: "chatcmpl_topic_discovery",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-4.1-mini",
          choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ items: [candidate] }) }, finish_reason: "stop" }],
        },
      }));

    const result = await provider.structured("Find topic resources", { schema: CandidateArraySchema, useSearch: true });
    const request = JSON.parse(mockFetch.mock.calls[1][1].body as string);
    const responseSchema = request.response_format.json_schema.schema;

    expect(responseSchema).toMatchObject({ type: "object", required: ["items"], additionalProperties: false });
    expect(responseSchema.properties.items.type).toBe("array");
    expect(JSON.stringify(responseSchema)).not.toMatch(/"(?:format|minLength|maxLength|pattern)"/);
    expect(result.data).toEqual([candidate]);
    expect(result.searchCitations).toEqual([{ url: "https://www.khanacademy.org/math/geometry" }]);
  });

  test("topic discovery rejects malformed wrapped candidates after required web search", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFetch
      .mockResolvedValueOnce(createMockResponsesResponse({
        json: {
          id: "resp_topic_search_malformed",
          object: "response",
          created_at: Date.now(),
          model: "gpt-4.1-mini",
          output: [
            { type: "web_search_call", status: "completed", action: { type: "search", query: "geometry", sources: [{ type: "url", url: "https://example.org/geometry" }] } },
            { type: "message", role: "assistant", content: [{ type: "output_text", text: "Research result." }] },
          ],
        },
      }))
      .mockResolvedValueOnce(createMockResponse({
        json: {
          id: "chatcmpl_topic_discovery_malformed",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-4.1-mini",
          choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ items: [{
            url: "not a URL",
            title: "",
            resource_type: "text",
            source_domain: "example.org",
            ai_note: "Candidate explanation",
            license_status: "link_only",
          }] }) }, finish_reason: "stop" }],
        },
      }));

    await expect(provider.structured("Find topic resources", { schema: CandidateArraySchema, useSearch: true })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    const validationLog = consoleWarn.mock.calls.find(([message]) => message === "[Azure] Structured discovery rejected")?.[1] as { failure_category: string; validation_issues: Array<{ path: string; message: string }> };
    expect(validationLog.failure_category).toBe("schema_validation");
    expect(validationLog.validation_issues.map((issue) => issue.path)).toEqual(expect.arrayContaining(["0.url", "0.title"]));
    consoleWarn.mockRestore();
  });

  test("logs safe Azure request metadata when the structured response schema is rejected", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const privateProviderMessage = "private Azure error details";
    mockFetch
      .mockResolvedValueOnce(createMockResponsesResponse({
        json: {
          id: "resp_topic_search_schema_error",
          object: "response",
          created_at: Date.now(),
          model: "gpt-4.1-mini",
          output: [
            { type: "web_search_call", status: "completed", action: { type: "search", query: "geometry", sources: [{ type: "url", url: "https://example.org/geometry" }] } },
            { type: "message", role: "assistant", content: [{ type: "output_text", text: "Research result." }] },
          ],
        },
      }))
      .mockResolvedValueOnce(createMockResponse({
        status: 400,
        ok: false,
        text: JSON.stringify({ error: { code: "invalid_json_schema", message: privateProviderMessage } }),
      }));

    await expect(provider.structured("Find topic resources", {
      schema: CandidateArraySchema,
      useSearch: true,
      diagnostics: { curriculumId: "curr-1", jobId: "job-1", streamId: "stream-1", topicId: "topic-1", operation: "topic_discovery_ai" },
    })).rejects.toMatchObject({ code: "INVALID_REQUEST", statusCode: 400, providerErrorCode: "invalid_json_schema" });

    const requestFailureLog = consoleError.mock.calls.find(([message]) => message === "[Azure] Structured response request failed")?.[1];
    expect(requestFailureLog).toMatchObject({
      operation: "topic_discovery_ai",
      curriculum_id: "curr-1",
      job_id: "job-1",
      stream_id: "stream-1",
      topic_id: "topic-1",
      failure_category: "azure_response_format_rejected",
      status_code: 400,
      azure_error_code: "invalid_json_schema",
      ai_error_code: "INVALID_REQUEST",
    });
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(privateProviderMessage);
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("test-azure-key");
    consoleError.mockRestore();
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
        model: "gpt-4.1-mini",
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
        model: "gpt-4.1-mini",
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

  test("capabilities reflects native structured output, web search, no streaming", () => {
    expect(provider.capabilities).toEqual({
      structuredOutput: true,
      webSearch: true,
      streaming: false,
    });
  });

  test("provider name is azure", () => {
    expect(provider.name).toBe("azure");
  });

  test("throws on missing API key", () => {
    expect(() => new AzureProvider({ apiKey: "", endpoint: "https://test.openai.azure.com", deployment: "test" })).toThrow("Azure OpenAI API key is required");
  });

  test("throws on missing endpoint", () => {
    expect(() => new AzureProvider({ apiKey: "test", endpoint: "", deployment: "test" })).toThrow("Azure OpenAI endpoint is required");
  });

  test("throws on missing deployment", () => {
    expect(() => new AzureProvider({ apiKey: "test", endpoint: "https://test.openai.azure.com", deployment: "" })).toThrow("Azure OpenAI deployment name is required");
  });

  test("throws on invalid endpoint URL", () => {
    try {
      new AzureProvider({ apiKey: "test", endpoint: "not-a-url", deployment: "test" });
      throw new Error("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AIError);
      expect((err as AIError).code).toBe("INVALID_REQUEST");
    }
  });

  test("structured() with useSearch=true searches first, then returns schema-valid data with citations", async () => {
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});
    const controller = new AbortController();
    const schema = z.object({
      resources: z.array(z.object({
        url: z.string().url(),
        title: z.string().min(1),
      })),
    });

    mockFetch
      .mockResolvedValueOnce(createMockResponsesResponse({
        json: {
          id: "resp_search_test",
          object: "response",
          created_at: Date.now(),
          model: "gpt-4.1-mini",
          output: [
            {
              type: "web_search_call",
              status: "completed",
              id: "search_1",
              action: { type: "search", query: "fraction arithmetic learning resources" },
            },
            {
              type: "message",
              status: "completed",
              role: "assistant",
              content: [{
                type: "output_text",
                text: "A useful lesson on fractions is available from Khan Academy.",
                annotations: [{
                  type: "url_citation",
                  url: "https://www.khanacademy.org/math/arithmetic/fraction-arithmetic",
                  title: "Fraction arithmetic",
                  start_index: 0,
                  end_index: 60,
                }],
              }],
            },
          ],
          usage: { input_tokens: 40, output_tokens: 25, total_tokens: 65 },
        },
      }))
      .mockResolvedValueOnce(createMockResponse({
      json: {
        id: "chatcmpl_test",
        object: "chat.completion",
        created: Date.now(),
        model: "gpt-4.1-mini",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: '{"resources":[{"url":"https://www.khanacademy.org/math/arithmetic/fraction-arithmetic","title":"Fraction arithmetic"}]}',
            tool_calls: undefined,
          },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      },
    }));

    const result = await provider.structured("Test prompt", { schema, useSearch: true, signal: controller.signal });

    expect(result.data).toEqual({
      resources: [{
        url: "https://www.khanacademy.org/math/arithmetic/fraction-arithmetic",
        title: "Fraction arithmetic",
      }],
    });
    expect(result.searchCompleted).toBe(true);
    expect(result.searchCitations).toEqual([{
      url: "https://www.khanacademy.org/math/arithmetic/fraction-arithmetic",
      title: "Fraction arithmetic",
    }]);
    expect(result.usage).toEqual({ inputTokens: 140, outputTokens: 75 });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[0][1].signal).toBe(controller.signal);
    expect(mockFetch.mock.calls[1][1].signal).toBe(controller.signal);
    expect(mockFetch.mock.calls[0][0]).toContain("/responses?");
    const searchBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(searchBody.model).toBe("gpt-4.1-mini");
    expect(searchBody.tools).toEqual([{ type: "web_search" }]);
    expect(searchBody.tool_choice).toBe("required");
    expect(searchBody.include).toEqual(["web_search_call.action.sources"]);

    expect(mockFetch.mock.calls[1][0]).toContain("/chat/completions");
    const structuredBody = JSON.parse(mockFetch.mock.calls[1][1].body as string);
    expect(structuredBody.response_format.type).toBe("json_schema");
    expect(structuredBody.messages[0].content).toContain("completed web research");
    expect(structuredBody.messages[0].content).toContain("https://www.khanacademy.org/math/arithmetic/fraction-arithmetic");
    expect(consoleInfo).toHaveBeenCalledWith("[Azure] Responses API web search summary", expect.objectContaining({
      provider: "azure",
      attempt_number: 1,
      response_item_types: ["web_search_call", "message"],
      search_call_statuses: ["completed"],
      returned_source_count: 0,
      annotation_count: 1,
      annotation_locations: ["response[1].content[0].annotations=1"],
      extracted_url_count: 1,
    }));
    consoleInfo.mockRestore();
  });

  test("structured() rejects a completed Responses API search with no usable citations", async () => {
    const schema = z.object({ result: z.string() });
    const citationFreeResponse = createMockResponsesResponse({
      json: {
        id: "resp_search_without_citations",
        object: "response",
        created_at: Date.now(),
        model: "gpt-4.1-mini",
        output: [
          {
            type: "web_search_call",
            status: "completed",
            id: "search_without_citations",
            action: { type: "search", query: "educational topic" },
          },
          {
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: "A result without citation annotations." }],
          },
        ],
      },
    });
    mockFetch.mockResolvedValueOnce(citationFreeResponse).mockResolvedValueOnce(citationFreeResponse);

    await expect(provider.structured("Test prompt", { schema, useSearch: true })).rejects.toMatchObject({
      code: "MODEL_ERROR",
      provider: "azure",
      message: "Azure web search completed without source citations; structured discovery was not generated.",
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[0][0]).toContain("/responses?");
    expect(mockFetch.mock.calls[1][0]).toContain("/responses?");
  });

  test("structured() retries a citation-free search once and grounds output in real citation annotations", async () => {
    const schema = z.object({ result: z.string() });
    const searchLogs = vi.spyOn(console, "info").mockImplementation(() => {});
    mockFetch
      .mockResolvedValueOnce(createMockResponsesResponse({
        json: {
          id: "resp_search_without_citations",
          object: "response",
          created_at: Date.now(),
          model: "gpt-4.1-mini",
          output: [
            { type: "web_search_call", status: "completed", id: "search_1" },
            { type: "message", role: "assistant", content: [{ type: "output_text", text: "No cited result." }] },
          ],
        },
      }))
      .mockResolvedValueOnce(createMockResponsesResponse({
        json: {
          id: "resp_search_with_citations",
          object: "response",
          created_at: Date.now(),
          model: "gpt-4.1-mini",
          output: [
            { type: "web_search_call", status: "completed", id: "search_2" },
            {
              type: "message",
              role: "assistant",
              content: [{
                type: "output_text",
                text: "A cited educational result.",
                annotations: [{ type: "url_citation", url: "https://example.org/geometry", title: "Geometry resource", start_index: 0, end_index: 10 }],
              }],
            },
          ],
        },
      }))
      .mockResolvedValueOnce(createMockResponse({
        json: {
          id: "chatcmpl_test",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-4.1-mini",
          choices: [{ index: 0, message: { role: "assistant", content: '{"result":"grounded"}' }, finish_reason: "stop" }],
        },
      }));

    const result = await provider.structured("Find a geometry resource", {
      schema,
      useSearch: true,
      diagnostics: { curriculumId: "curr-1", jobId: "job-1", streamId: "stream-1", topicId: "topic-1", operation: "topic_discovery_ai" },
    });

    expect(result.data).toEqual({ result: "grounded" });
    expect(result.searchCitations).toEqual([{ url: "https://example.org/geometry", title: "Geometry resource" }]);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch.mock.calls[0][0]).toContain("/responses?");
    expect(mockFetch.mock.calls[1][0]).toContain("/responses?");
    expect(mockFetch.mock.calls[2][0]).toContain("/chat/completions");
    const structuredRequest = JSON.parse(mockFetch.mock.calls[2][1].body as string);
    expect(structuredRequest.messages[0].content).toContain("https://example.org/geometry");
    const attemptLogs = searchLogs.mock.calls
      .filter(([message]) => message === "[Azure] Responses API web search summary")
      .map(([, details]) => details);
    expect(attemptLogs).toHaveLength(2);
    expect(attemptLogs.map((details: any) => details.attempt_number)).toEqual([1, 2]);
    expect(attemptLogs.every((details: any) => details.job_id === "job-1" && details.curriculum_id === "curr-1" && details.stream_id === "stream-1")).toBe(true);
    searchLogs.mockRestore();
  });

  test("structured() extracts consulted URLs from Azure web_search_call.action.sources", async () => {
    const schema = z.object({ result: z.string() });
    const searchLogs = vi.spyOn(console, "info").mockImplementation(() => {});
    mockFetch
      .mockResolvedValueOnce(createMockResponsesResponse({
        json: {
          id: "resp_action_sources",
          object: "response",
          created_at: Date.now(),
          model: "gpt-4.1-mini",
          output: [
            {
              type: "web_search_call",
              status: "completed",
              id: "search_with_sources",
              action: { type: "search", query: "geometry resource", sources: [
                { type: "url", url: "https://example.org/consulted-geometry" },
                { type: "url", url: "not a valid URL" },
                { type: "url" },
              ] },
            },
            { type: "message", role: "assistant", content: [{ type: "output_text", text: "Grounded research without inline annotations." }] },
          ],
        },
      }))
      .mockResolvedValueOnce(createMockResponse({
        json: {
          id: "chatcmpl_test",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-4.1-mini",
          choices: [{ index: 0, message: { role: "assistant", content: '{"result":"grounded"}' }, finish_reason: "stop" }],
        },
      }));

    const result = await provider.structured("Find a geometry resource", { schema, useSearch: true });

    expect(result.data).toEqual({ result: "grounded" });
    expect(result.searchCitations).toEqual([{ url: "https://example.org/consulted-geometry" }]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const searchRequest = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(searchRequest.include).toEqual(["web_search_call.action.sources"]);
    const groundedRequest = JSON.parse(mockFetch.mock.calls[1][1].body as string);
    expect(groundedRequest.messages[0].content).toContain("https://example.org/consulted-geometry");
    const summary = searchLogs.mock.calls.find(([message]) => message === "[Azure] Responses API web search summary")?.[1] as Record<string, unknown>;
    expect(summary).toMatchObject({ returned_source_count: 3, source_entries_without_url_count: 1, invalid_source_url_count: 1, extracted_url_count: 1 });
    searchLogs.mockRestore();
  });

  test("structured() with useSearch=true fails clearly and skips structured generation when web search fails", async () => {
    const schema = z.object({ result: z.string() });
    mockFetch.mockResolvedValueOnce(createMockResponsesResponse({
      json: {
        id: "resp_search_failed",
        object: "response",
        created_at: Date.now(),
        model: "gpt-4.1-mini",
        output: [
          { type: "web_search_call", status: "failed", id: "search_1" },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "No verified research." }] },
        ],
      },
    }));

    await expect(provider.structured("Test prompt", { schema, useSearch: true })).rejects.toMatchObject({
      code: "MODEL_ERROR",
      provider: "azure",
      message: "Azure web search did not complete; structured discovery was not generated.",
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toContain("/responses?");
  });

  test("structured() throws on malformed JSON from provider", async () => {
    const schema = z.object({
      name: z.string(),
    });

    mockFetch.mockResolvedValue(createMockResponse({
      json: {
        id: "chatcmpl_test",
        object: "chat.completion",
        created: Date.now(),
        model: "gpt-4.1-mini",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: "not valid json",
            tool_calls: undefined,
          },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      },
    }));

    await expect(provider.structured("Test prompt", { schema })).rejects.toThrow(AIError);
    await expect(provider.structured("Test prompt", { schema })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
  });
});

describe("AzureProvider - Factory Integration", () => {
  let createProvider: typeof import("../factory").createProvider;
  let getAIProvider: typeof import("../factory").getAIProvider;
  let resetAIProvider: typeof import("../factory").resetAIProvider;

  beforeAll(async () => {
    const factory = await import("../factory");
    createProvider = factory.createProvider;
    getAIProvider = factory.getAIProvider;
    resetAIProvider = factory.resetAIProvider;
  });

  beforeEach(() => {
    resetAIProvider();
    delete process.env.AI_PROVIDER;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.AZURE_OPENAI_API_KEY;
    delete process.env.AZURE_OPENAI_ENDPOINT;
    delete process.env.AZURE_OPENAI_DEPLOYMENT;
    delete process.env.AZURE_OPENAI_API_VERSION;
    delete process.env.AZURE_OPENAI_USE_V1_ENDPOINT;
    delete process.env.AI_DEFAULT_MODEL;
    delete process.env.AI_DEBUG;
  });

  afterEach(() => {
    resetAIProvider();
  });

  test("createProvider creates AzureProvider with all required config", () => {
    process.env.AZURE_OPENAI_ENDPOINT = "https://test.openai.azure.com";
    process.env.AZURE_OPENAI_DEPLOYMENT = "gpt-4.1-mini";

    const provider = createProvider({
      provider: "azure",
      apiKey: "test-azure-key",
    });
    expect(provider.name).toBe("azure");
  });

  test("createProvider throws for azure without api key", () => {
    process.env.AZURE_OPENAI_ENDPOINT = "https://test.openai.azure.com";
    process.env.AZURE_OPENAI_DEPLOYMENT = "gpt-4.1-mini";

    expect(() => createProvider({ provider: "azure" })).toThrow("AZURE_OPENAI_API_KEY is required");
  });

  test("createProvider throws for azure without endpoint", () => {
    expect(() => createProvider({ provider: "azure", apiKey: "test" })).toThrow("AZURE_OPENAI_ENDPOINT is required");
  });

  test("createProvider throws for azure without deployment", () => {
    process.env.AZURE_OPENAI_ENDPOINT = "https://test.openai.azure.com";
    expect(() => createProvider({ provider: "azure", apiKey: "test" })).toThrow("AZURE_OPENAI_DEPLOYMENT is required");
  });

  test("getAIProvider selects azure via AI_PROVIDER env var", () => {
    process.env.AI_PROVIDER = "azure";
    process.env.AZURE_OPENAI_API_KEY = "env-azure-key";
    process.env.AZURE_OPENAI_ENDPOINT = "https://test.openai.azure.com";
    process.env.AZURE_OPENAI_DEPLOYMENT = "gpt-4.1-mini";

    const provider = getAIProvider();
    expect(provider.name).toBe("azure");
  });

  test("getAIProvider fails fast when AI_PROVIDER=azure but AZURE_OPENAI_API_KEY missing", () => {
    process.env.AI_PROVIDER = "azure";
    process.env.AZURE_OPENAI_ENDPOINT = "https://test.openai.azure.com";
    process.env.AZURE_OPENAI_DEPLOYMENT = "gpt-4.1-mini";
    // AZURE_OPENAI_API_KEY not set

    expect(() => getAIProvider()).toThrow("AZURE_OPENAI_API_KEY is required but not set");
  });

  test("getAIProvider fails fast when AI_PROVIDER=azure but AZURE_OPENAI_ENDPOINT missing", () => {
    process.env.AI_PROVIDER = "azure";
    process.env.AZURE_OPENAI_API_KEY = "test";
    process.env.AZURE_OPENAI_DEPLOYMENT = "gpt-4.1-mini";
    // AZURE_OPENAI_ENDPOINT not set

    expect(() => getAIProvider()).toThrow("AZURE_OPENAI_ENDPOINT is required");
  });

  test("getAIProvider fails fast when AI_PROVIDER=azure but AZURE_OPENAI_DEPLOYMENT missing", () => {
    process.env.AI_PROVIDER = "azure";
    process.env.AZURE_OPENAI_API_KEY = "test";
    process.env.AZURE_OPENAI_ENDPOINT = "https://test.openai.azure.com";
    // AZURE_OPENAI_DEPLOYMENT not set

    expect(() => getAIProvider()).toThrow("AZURE_OPENAI_DEPLOYMENT is required");
  });

  test("explicit config overrides environment variables for azure", () => {
    process.env.AI_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "env-anthropic-key";
    process.env.AZURE_OPENAI_ENDPOINT = "https://env.openai.azure.com";
    process.env.AZURE_OPENAI_DEPLOYMENT = "env-deployment";

    const provider = getAIProvider({ provider: "azure", apiKey: "explicit-key" });
    expect(provider.name).toBe("azure");
  });

  test("azure provider uses AZURE_OPENAI_API_VERSION from env when set", () => {
    process.env.AI_PROVIDER = "azure";
    process.env.AZURE_OPENAI_API_KEY = "test";
    process.env.AZURE_OPENAI_ENDPOINT = "https://test.openai.azure.com";
    process.env.AZURE_OPENAI_DEPLOYMENT = "gpt-4.1-mini";
    process.env.AZURE_OPENAI_API_VERSION = "2024-10-01-preview";

    const provider = getAIProvider() as AzureProvider;
    expect(provider).toBeInstanceOf(AzureProvider);
  });

  test("azure provider uses AZURE_OPENAI_USE_V1_ENDPOINT from env when set", () => {
    process.env.AI_PROVIDER = "azure";
    process.env.AZURE_OPENAI_API_KEY = "test";
    process.env.AZURE_OPENAI_ENDPOINT = "https://test.openai.azure.com";
    process.env.AZURE_OPENAI_DEPLOYMENT = "gpt-4.1-mini";
    process.env.AZURE_OPENAI_USE_V1_ENDPOINT = "true";

    const provider = getAIProvider() as AzureProvider;
    expect(provider).toBeInstanceOf(AzureProvider);
  });

  test("credential isolation: azure provider never reads OPENROUTER_API_KEY", () => {
    process.env.AI_PROVIDER = "azure";
    process.env.AZURE_OPENAI_API_KEY = "azure-key";
    process.env.AZURE_OPENAI_ENDPOINT = "https://test.openai.azure.com";
    process.env.AZURE_OPENAI_DEPLOYMENT = "gpt-4.1-mini";
    process.env.OPENROUTER_API_KEY = "openrouter-key-should-be-ignored";

    const provider = getAIProvider();
    expect(provider.name).toBe("azure");
  });

  test("credential isolation: openrouter provider never reads AZURE_OPENAI_API_KEY", () => {
    process.env.AI_PROVIDER = "openrouter";
    process.env.OPENROUTER_API_KEY = "openrouter-key";
    process.env.AZURE_OPENAI_API_KEY = "azure-key-should-be-ignored";

    const provider = getAIProvider();
    expect(provider.name).toBe("openrouter");
  });

  test("switching providers creates new instance", () => {
    process.env.AI_PROVIDER = "azure";
    process.env.AZURE_OPENAI_API_KEY = "key1";
    process.env.AZURE_OPENAI_ENDPOINT = "https://test1.openai.azure.com";
    process.env.AZURE_OPENAI_DEPLOYMENT = "deployment1";
    const provider1 = getAIProvider();

    resetAIProvider();

    process.env.AI_PROVIDER = "openrouter";
    process.env.OPENROUTER_API_KEY = "key2";
    const provider2 = getAIProvider();

    expect(provider1.name).toBe("azure");
    expect(provider2.name).toBe("openrouter");
    expect(provider1).not.toBe(provider2);
  });
});
