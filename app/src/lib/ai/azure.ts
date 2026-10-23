/**
 * Azure AI Foundry Provider Adapter
 * Implements AIProvider interface for Azure OpenAI API.
 * Uses chat completions for non-search calls and Responses API for web search.
 */

import { z } from "zod";
import {
  AIProvider,
  AICompleteOptions,
  AIStructuredOptions,
  AICompleteResult,
  AIStructuredResult,
  AIError,
  AIErrorCode,
  AIProviderCapabilities,
  AISearchCitation,
} from "./types";

const DEFAULT_MAX_TOKENS = 4000;
const DEFAULT_API_VERSION = "2024-12-01-preview";

/** Azure OpenAI chat completions request format (OpenAI-compatible) */
interface AzureChatRequest {
  model?: string;
  max_tokens?: number;
  temperature?: number;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  response_format?: { type: "json_schema"; json_schema: { name: string; schema: object; strict?: boolean } };
  stream?: boolean;
}

/** Azure OpenAI chat completions response format */
interface AzureChatResponse {
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
}

/** Azure OpenAI Responses API request format */
interface AzureResponsesRequest {
  model: string;
  input: string;
  max_output_tokens?: number;
  temperature?: number;
  tools?: Array<{ type: "web_search" }>;
  tool_choice?: "auto" | "required" | { type: "web_search" };
  response_format?: { type: "json_schema"; json_schema: { name: string; schema: object; strict?: boolean } };
}

/** URL citation annotation from Responses API message content */
interface AzureUrlCitationAnnotation {
  type: "url_citation";
  url: string;
  title?: string;
  start_index: number;
  end_index: number;
}

/** Azure OpenAI Responses API response format */
interface AzureResponsesResponse {
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
      annotations?: AzureUrlCitationAnnotation[];
    }>;
    // web_search_call output - status indicates if search completed
    id?: string;
    status?: "completed" | "in_progress" | "failed";
    query?: string;
  }>;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
}

/** Summarize annotation placement without exposing response text or citation URLs. */
function summarizeAnnotationLocations(value: unknown, path = "response", locations: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((item, index) => summarizeAnnotationLocations(item, `${path}[${index}]`, locations));
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key === "annotations" && Array.isArray(child)) {
        locations.push(`${path}.annotations=${child.length}`);
      } else if (typeof child === "object" && child !== null) {
        summarizeAnnotationLocations(child, `${path}.${key}`, locations);
      }
    }
  }
  return locations;
}

/**
 * Azure AI Foundry provider implementation.
 * Uses chat completions for non-search calls and Responses API for web search.
 */
export class AzureProvider implements AIProvider {
  public readonly name = "azure";
  public readonly capabilities: AIProviderCapabilities = {
    structuredOutput: true,
    webSearch: true, // Now supports web search via Responses API
    streaming: false,
  };

  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly deployment: string;
  private readonly apiVersion: string;
  private readonly defaultMaxTokens: number;
  private readonly debug: boolean;
  private readonly retryDelayMs: number | ((attempt: number) => number);
  private readonly useV1Endpoint: boolean;

  constructor(config: {
    apiKey: string;
    endpoint: string;
    deployment: string;
    apiVersion?: string;
    defaultModel?: string;
    defaultMaxTokens?: number;
    debug?: boolean;
    retryDelayMs?: number | ((attempt: number) => number);
    useV1Endpoint?: boolean;
  }) {
    if (!config.apiKey) {
      throw new Error("Azure OpenAI API key is required");
    }
    if (!config.endpoint) {
      throw new Error("Azure OpenAI endpoint is required (e.g., https://my-resource.openai.azure.com)");
    }
    if (!config.deployment) {
      throw new Error("Azure OpenAI deployment name is required");
    }

    this.apiKey = config.apiKey;
    this.endpoint = config.endpoint.replace(/\/$/, "");
    this.deployment = config.deployment;
    this.apiVersion = config.apiVersion ?? DEFAULT_API_VERSION;
    this.defaultMaxTokens = config.defaultMaxTokens ?? DEFAULT_MAX_TOKENS;
    this.debug = config.debug ?? false;
    this.retryDelayMs = config.retryDelayMs ?? ((attempt: number) => attempt * 30_000);
    this.useV1Endpoint = config.useV1Endpoint ?? false;

    try {
      new URL(this.endpoint);
    } catch {
      throw new AIError("INVALID_REQUEST", `Invalid Azure endpoint URL: ${this.endpoint}`, {
        provider: "azure",
      });
    }
  }

  /**
   * Build the chat completions API URL.
   * For v1 endpoint: uses OpenAI-compatible format without legacy api-version parameter.
   * For legacy endpoint: uses deployment-specific path with api-version.
   */
  private buildChatUrl(): string {
    if (this.useV1Endpoint) {
      // v1 endpoint: base URL already includes /openai/v1, no api-version parameter
      // e.g., https://resource.services.ai.azure.com/openai/v1/chat/completions
      return `${this.endpoint}/chat/completions`;
    } else {
      // Legacy endpoint: deployment-specific path with api-version
      return `${this.endpoint}/openai/deployments/${this.deployment}/chat/completions?api-version=${this.apiVersion}`;
    }
  }

  /**
   * Build the Responses API URL for web search.
   * For v1 endpoint: uses OpenAI-compatible format without legacy api-version parameter.
   * For legacy endpoint: uses deployment-specific path with api-version.
   */
  private buildResponsesUrl(): string {
    if (this.useV1Endpoint) {
      // v1 endpoint: base URL already includes /openai/v1, no api-version parameter
      // e.g., https://resource.services.ai.azure.com/openai/v1/responses
      return `${this.endpoint}/responses`;
    } else {
      // Legacy endpoint: deployment-specific path with api-version
      return `${this.endpoint}/openai/deployments/${this.deployment}/responses?api-version=${this.apiVersion}`;
    }
  }

  /**
   * Build chat completions request body.
   */
  private buildChatRequest(prompt: string, options: AICompleteOptions = {}): AzureChatRequest {
    const messages: AzureChatRequest["messages"] = [];

    if (options.systemPrompt) {
      messages.push({ role: "system", content: options.systemPrompt });
    }
    messages.push({ role: "user", content: prompt });

    const request: AzureChatRequest = { messages };

    if (this.useV1Endpoint) {
      request.model = this.deployment;
    }

    if (options.maxTokens !== undefined) {
      request.max_tokens = options.maxTokens;
    } else {
      request.max_tokens = this.defaultMaxTokens;
    }

    if (options.temperature !== undefined) {
      request.temperature = options.temperature;
    }

    return request;
  }

  /**
   * Build Responses API request body for web search.
   */
  private buildResponsesRequest(prompt: string, options: AICompleteOptions = {}): AzureResponsesRequest {
    const request: AzureResponsesRequest = {
      model: this.deployment,
      input: prompt,
    };

    if (options.systemPrompt) {
      request.input = `${options.systemPrompt}\n\n${prompt}`;
    }

    if (options.maxTokens !== undefined) {
      request.max_output_tokens = options.maxTokens;
    } else {
      request.max_output_tokens = this.defaultMaxTokens;
    }

    if (options.temperature !== undefined) {
      request.temperature = options.temperature;
    }

    // Enable web search tool - require it to ensure actual search happens
    request.tools = [{ type: "web_search" }];
    request.tool_choice = "required";

    return request;
  }

  /**
   * Build chat completions request for structured output.
   */
  private buildStructuredChatRequest<T>(
    prompt: string,
    schema: z.ZodSchema<T>,
    options: AICompleteOptions = {}
  ): AzureChatRequest {
    const baseRequest = this.buildChatRequest(prompt, options);
    const jsonSchema = this.zodToJsonSchema(schema);

    return {
      ...baseRequest,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "structured_response",
          schema: jsonSchema,
          strict: true,
        },
      },
      temperature: options.temperature ?? 0,
    };
  }

  /**
   * Convert Zod schema to JSON Schema.
   */
  private zodToJsonSchema(schema: z.ZodSchema): object {
    type ZodSchemaInternal = z.ZodSchema & {
      _def: {
        typeName: string;
        schema?: z.ZodSchema;
        innerType?: z.ZodSchema;
        shape?: () => Record<string, z.ZodSchema>;
        type?: z.ZodSchema;
        checks?: Array<{ kind: string; value?: unknown; regex?: RegExp }>;
        values?: string[];
        options?: z.ZodSchema[];
      };
    };

    let unwrapped: ZodSchemaInternal = schema as ZodSchemaInternal;
    while (unwrapped._def?.typeName === "ZodEffects") {
      unwrapped = unwrapped._def.schema as ZodSchemaInternal;
    }

    const def = unwrapped._def;

    switch (def.typeName) {
      case "ZodObject": {
        const shape: Record<string, unknown> = {};
        const required: string[] = [];
        const shapeDef = def.shape?.() ?? {};
        for (const [key, value] of Object.entries(shapeDef)) {
          shape[key] = this.zodToJsonSchema(value);
          // In strict mode (which we always use), ALL properties must be in required array.
          // Nullable/optional fields are indicated by nullable: true in the property schema.
          required.push(key);
        }
        return {
          type: "object",
          properties: shape,
          required,
          additionalProperties: false,
        };
      }

      case "ZodArray": {
        return {
          type: "array",
          items: def.type ? this.zodToJsonSchema(def.type) : {},
        };
      }

      case "ZodString": {
        const checks = def.checks ?? [];
        const schema: Record<string, unknown> = { type: "string" };
        for (const check of checks) {
          if (check.kind === "min") schema.minLength = check.value;
          if (check.kind === "max") schema.maxLength = check.value;
          if (check.kind === "regex" && check.regex) schema.pattern = check.regex.source;
          if (check.kind === "email") schema.format = "email";
          if (check.kind === "url") schema.format = "uri";
        }
        return schema;
      }

      case "ZodNumber": {
        const checks = def.checks ?? [];
        const schema: Record<string, unknown> = { type: "number" };
        for (const check of checks) {
          if (check.kind === "min") schema.minimum = check.value;
          if (check.kind === "max") schema.maximum = check.value;
          if (check.kind === "int") schema.type = "integer";
        }
        return schema;
      }

      case "ZodBoolean": {
        return { type: "boolean" };
      }

      case "ZodEnum": {
        return { type: "string", enum: def.values };
      }

      case "ZodOptional": {
        return def.innerType ? this.zodToJsonSchema(def.innerType) : { type: "object", additionalProperties: true };
      }

      case "ZodNullable": {
        return def.innerType
          ? { ...this.zodToJsonSchema(def.innerType), nullable: true }
          : { type: "object", additionalProperties: true, nullable: true };
      }

      case "ZodUnion": {
        return {
          anyOf: (def.options ?? []).map((opt: z.ZodSchema) => this.zodToJsonSchema(opt)),
        };
      }

      case "ZodDefault": {
        return def.innerType ? this.zodToJsonSchema(def.innerType) : { type: "object", additionalProperties: true };
      }

      default: {
        if (this.debug) {
          console.warn(`[Azure] Unsupported Zod type: ${def.typeName}, using empty object schema`);
        }
        return { type: "object", additionalProperties: true };
      }
    }
  }

  /**
   * Make HTTP request with retry logic.
   */
  private async requestWithRetry<T>(
    url: string,
    requestBody: AzureChatRequest | AzureResponsesRequest,
    maxAttempts = 4,
    signal?: AbortSignal
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        const waitMs = typeof this.retryDelayMs === "function"
          ? this.retryDelayMs(attempt)
          : this.retryDelayMs;
        if (this.debug) {
          console.log(`[Azure] Rate limited or server error, waiting ${waitMs / 1000}s before retry ${attempt}...`);
        }
        try {
          await new Promise<void>((resolve, reject) => {
            if (signal?.aborted) {
              reject(new DOMException("Aborted", "AbortError"));
              return;
            }
            const timeout = setTimeout(resolve, waitMs);
            if (signal) {
              signal.addEventListener("abort", () => {
                clearTimeout(timeout);
                reject(new DOMException("Aborted", "AbortError"));
              }, { once: true });
            }
          });
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") {
            throw new AIError("ABORTED", "Request aborted", {
              retryable: false,
              provider: "azure",
            });
          }
          throw err;
        }
      }

      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "api-key": this.apiKey,
          },
          body: JSON.stringify(requestBody),
          signal,
        });

        if (response.status === 429) {
          const errorText = await response.text();
          let retryAfter = 0;
          const retryAfterHeader = response.headers.get("Retry-After");
          if (retryAfterHeader) {
            const parsed = parseInt(retryAfterHeader, 10);
            if (!isNaN(parsed)) retryAfter = parsed * 1000;
          }
          lastError = new AIError("RATE_LIMITED", `Rate limited: ${errorText}`, {
            statusCode: 429,
            retryable: true,
            provider: "azure",
          });
          if (retryAfter > 0) {
            if (this.debug) {
              console.log(`[Azure] Server sent Retry-After: ${retryAfter}ms`);
            }
            await new Promise<void>((resolve, reject) => {
              if (signal?.aborted) {
                reject(new DOMException("Aborted", "AbortError"));
                return;
              }
              const timeout = setTimeout(resolve, retryAfter);
              if (signal) {
                signal.addEventListener("abort", () => {
                  clearTimeout(timeout);
                  reject(new DOMException("Aborted", "AbortError"));
                }, { once: true });
              }
            });
          }
          continue;
        }

        if (!response.ok) {
          const errorText = await response.text();
          let errorCode: AIErrorCode = "UNKNOWN_ERROR";
          let retryable = false;

          if (response.status === 401) {
            errorCode = "AUTH_ERROR";
          } else if (response.status === 400) {
            errorCode = "INVALID_REQUEST";
          } else if (response.status === 402) {
            errorCode = "MODEL_ERROR";
            retryable = false;
          } else if (response.status >= 500) {
            errorCode = "MODEL_ERROR";
            retryable = true;
          }

          lastError = new AIError(errorCode, `Azure OpenAI API error (${response.status}): ${errorText}`, {
            statusCode: response.status,
            retryable,
            provider: "azure",
          });

          if (!retryable) {
            throw lastError;
          }
          continue;
        }

        const data = await response.json() as T;
        return data;
      } catch (err) {
        if (err instanceof AIError) {
          throw err;
        }
        if (err instanceof DOMException && err.name === "AbortError") {
          throw new AIError("ABORTED", "Request aborted", {
            retryable: false,
            provider: "azure",
          });
        }
        lastError = new AIError("NETWORK_ERROR", `Network error: ${err instanceof Error ? err.message : String(err)}`, {
          retryable: true,
          provider: "azure",
        });
        if (attempt === maxAttempts - 1) {
          throw lastError;
        }
      }
    }

    throw lastError ?? new AIError("UNKNOWN_ERROR", "Max retries exceeded", {
      provider: "azure",
    });
  }

  /**
   * Extract text and citations from Responses API response.
   * Citations come from message content annotations (url_citation type).
   * The web_search_call output indicates search status but doesn't contain results directly.
   */
  private extractResponsesResult(response: AzureResponsesResponse): { text: string; citations: AISearchCitation[]; searchCompleted: boolean } {
    let text = "";
    const citations: AISearchCitation[] = [];
    let sawSearchCall = false;
    let allSearchCallsCompleted = true;
    const searchCallStatuses: string[] = [];

    for (const output of response.output) {
      if (output.type === "message" && output.content) {
        for (const content of output.content) {
          if (content.type === "output_text") {
            text += content.text;
            // Extract citations from annotations
            if (content.annotations) {
              for (const annotation of content.annotations) {
                if (annotation.type === "url_citation" && annotation.url) {
                  citations.push({
                    url: annotation.url,
                    title: annotation.title,
                    // snippet not available in url_citation annotation
                  });
                }
              }
            }
          }
        }
      } else if (output.type === "web_search_call") {
        // Require every returned search call to finish; an in-progress or failed
        // call must not be reported as successful just because another completed.
        sawSearchCall = true;
        searchCallStatuses.push(output.status ?? "missing");
        if (output.status !== "completed") {
          allSearchCallsCompleted = false;
        }
        if (output.status === "failed" && this.debug) {
          console.warn("[Azure] Web search call failed", { query: output.query, id: output.id });
        }
      }
    }

    // Keep diagnostics structural only: never log user prompts or model output.
    const annotationLocations = summarizeAnnotationLocations(response.output);
    const annotationCount = annotationLocations.reduce((total, location) => {
      const count = Number(location.slice(location.lastIndexOf("=") + 1));
      return total + (Number.isFinite(count) ? count : 0);
    }, 0);
    console.info("[Azure] Responses API web search summary", {
      response_item_types: response.output.map((item) => item.type),
      search_call_statuses: searchCallStatuses,
      annotation_count: annotationCount,
      annotation_locations: annotationLocations,
      extracted_url_count: citations.length,
    });

    if (text === "" && this.debug) {
      console.warn("[Azure] Empty response content received", { output: response.output });
    }

    return { text, citations, searchCompleted: sawSearchCall && allSearchCallsCompleted };
  }

  /**
   * Extract text from chat completions response.
   */
  private extractChatText(response: AzureChatResponse): string {
    const choice = response.choices[0];
    if (!choice) {
      throw new Error("No choices in Azure OpenAI response");
    }
    const content = choice.message.content ?? "";
    if (content === "" && this.debug) {
      console.warn("[Azure] Empty response content received", { finish_reason: choice.finish_reason });
    }
    return content;
  }

  /**
   * Extract and parse JSON from chat completions structured response.
   */
  private extractStructuredJson<T>(response: AzureChatResponse): T {
    const text = this.extractChatText(response);
    if (!text) {
      throw new Error("Empty response content");
    }
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new Error(`Failed to parse JSON from structured response: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Generate a text completion.
   * Uses Responses API with web search when useSearch=true, otherwise chat completions.
   */
  async complete(prompt: string, options: AICompleteOptions = {}): Promise<AICompleteResult> {
    const useSearch = options.useSearch ?? false;

    if (useSearch) {
      // Use Responses API with web search tool
      const request = this.buildResponsesRequest(prompt, options);
      const url = this.buildResponsesUrl();
      const response = await this.requestWithRetry<AzureResponsesResponse>(url, request, 4, options.signal);

      const { text, citations, searchCompleted } = this.extractResponsesResult(response);

      // Treat missing successful search as a failure - we need actual web search
      if (!searchCompleted) {
        if (this.debug) {
          console.warn("[Azure] Web search did not complete successfully", { citations: citations.length });
        }
        // Still return the response but log the issue - caller can decide how to handle
      }

      return {
        text,
        usage: response.usage ? {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        } : undefined,
        raw: this.debug ? response : undefined,
        searchCitations: citations.length > 0 ? citations : undefined,
        searchCompleted,
      };
    } else {
      // Use chat completions for non-search calls
      const request = this.buildChatRequest(prompt, options);
      const url = this.buildChatUrl();
      const response = await this.requestWithRetry<AzureChatResponse>(url, request, 4, options.signal);

      const text = this.extractChatText(response);

      return {
        text,
        usage: response.usage ? {
          inputTokens: response.usage.prompt_tokens,
          outputTokens: response.usage.completion_tokens,
        } : undefined,
        raw: this.debug ? response : undefined,
      };
    }
  }

  /**
   * Generate structured output with native JSON Schema validation.
   * Search requests use a required Responses API web search first, then a
   * schema-constrained chat completion grounded in those results. This keeps
   * the required search behavior explicit and preserves the response citations.
   */
  async structured<T>(prompt: string, options: AIStructuredOptions<T>): Promise<AIStructuredResult<T>> {
    const { schema, useSearch = false, ...completeOptions } = options;
    const searchResult = useSearch
      ? await this.complete(prompt, { ...completeOptions, useSearch: true })
      : undefined;

    if (searchResult && searchResult.searchCompleted !== true) {
      throw new AIError("MODEL_ERROR", "Azure web search did not complete; structured discovery was not generated.", {
        retryable: false,
        provider: "azure",
      });
    }

    const searchCitations = searchResult?.searchCitations ?? [];
    if (searchResult && searchCitations.length === 0) {
      throw new AIError("MODEL_ERROR", "Azure web search completed without source citations; structured discovery was not generated.", {
        retryable: false,
        provider: "azure",
      });
    }

    const groundedPrompt = searchResult
      ? [
          prompt,
          "\nUse the following completed web research to answer the request. Base factual claims and URLs only on these results; do not invent sources.",
          "\nWeb research results:",
          searchResult.text,
          "\nSource references:",
          ...searchCitations.map((citation, index) => `${index + 1}. ${citation.title ? `${citation.title} — ` : ""}${citation.url}`),
        ].join("\n")
      : prompt;

    const request = this.buildStructuredChatRequest(groundedPrompt, schema, completeOptions);
    const url = this.buildChatUrl();
    const response = await this.requestWithRetry<AzureChatResponse>(url, request, 4, completeOptions.signal);

    const rawText = this.extractChatText(response);

    let parsedJson: T;
    try {
      parsedJson = this.extractStructuredJson<T>(response);
    } catch (err) {
      throw new AIError("INVALID_REQUEST", `Failed to parse structured response: ${err instanceof Error ? err.message : String(err)}`, {
        provider: "azure",
      });
    }

    const result = schema.safeParse(parsedJson);
    if (!result.success) {
      const errorMessages = result.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");
      throw new AIError("INVALID_REQUEST", `Schema validation failed: ${errorMessages}`, {
        provider: "azure",
      });
    }

    return {
      data: result.data,
      rawText,
      usage: response.usage || searchResult?.usage ? {
        inputTokens: (response.usage?.prompt_tokens ?? 0) + (searchResult?.usage?.inputTokens ?? 0),
        outputTokens: (response.usage?.completion_tokens ?? 0) + (searchResult?.usage?.outputTokens ?? 0),
      } : undefined,
      searchCitations: searchResult ? searchCitations : undefined,
      searchCompleted: searchResult ? true : undefined,
    };
  }
}
