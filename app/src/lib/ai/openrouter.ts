/**
 * OpenRouter Provider Adapter
 * Implements AIProvider interface for OpenRouter API (OpenAI-compatible).
 * Uses the `openrouter/free` model route for zero-cost inference.
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
} from "./types";

const FREE_MODEL = "openrouter/free";
const DEFAULT_MAX_TOKENS = 4000;
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1/chat/completions";

/** OpenRouter request format (OpenAI-compatible) */
interface OpenRouterRequest {
  model: string;
  max_tokens?: number;
  temperature?: number;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  tools?: Array<{ type: "function"; function: { name: string; description: string; parameters: object } }>;
  tool_choice?: "auto" | "none" | { type: "function"; function: { name: string } };
  response_format?: { type: "json_schema"; json_schema: { name: string; schema: object; strict?: boolean } };
  stream?: boolean;
}

/** OpenRouter response format (OpenAI-compatible) */
interface OpenRouterResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * OpenRouter provider implementation.
 * Uses the free model route for zero-cost inference.
 */
export class OpenRouterProvider implements AIProvider {
  public readonly name = "openrouter";
  public readonly capabilities: AIProviderCapabilities = {
    structuredOutput: true, // Native JSON Schema support via response_format
    webSearch: false, // Free models typically don't have web search; disabled for now
    streaming: false,
  };

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly defaultMaxTokens: number;
  private readonly debug: boolean;
  private readonly retryDelayMs: number | ((attempt: number) => number);

  constructor(config: {
    apiKey: string;
    baseUrl?: string;
    defaultModel?: string;
    defaultMaxTokens?: number;
    debug?: boolean;
    /** Custom retry delay for testing. Default: attempt * 30000. */
    retryDelayMs?: number | ((attempt: number) => number);
  }) {
    if (!config.apiKey) {
      throw new Error("OpenRouter API key is required");
    }
    // Enforce free-only model at construction: reject invalid configured default
    const configuredModel = config.defaultModel ?? FREE_MODEL;
    if (configuredModel !== FREE_MODEL) {
      throw new AIError("INVALID_REQUEST", `OpenRouter provider only supports the free model. Configured default model "${configuredModel}" is not allowed.`, {
        provider: "openrouter",
      });
    }
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.defaultModel = configuredModel;
    this.defaultMaxTokens = config.defaultMaxTokens ?? DEFAULT_MAX_TOKENS;
    this.debug = config.debug ?? false;
    this.retryDelayMs = config.retryDelayMs ?? ((attempt: number) => attempt * 30_000);
  }

  /**
   * Build the request body for OpenRouter API.
   * Enforces that every request uses exactly "openrouter/free".
   */
  private buildRequest(prompt: string, options: AICompleteOptions = {}): OpenRouterRequest {
    // Enforce free-only model at call site: reject any override
    const requestedModel = options.model ?? this.defaultModel;
    if (requestedModel !== FREE_MODEL) {
      throw new AIError("INVALID_REQUEST", `OpenRouter provider only supports the free model. Requested model "${requestedModel}" is not allowed.`, {
        provider: "openrouter",
      });
    }

    const messages: OpenRouterRequest["messages"] = [];

    if (options.systemPrompt) {
      messages.push({ role: "system", content: options.systemPrompt });
    }
    messages.push({ role: "user", content: prompt });

    const request: OpenRouterRequest = {
      model: FREE_MODEL,
      messages,
    };

    if (options.maxTokens !== undefined) {
      request.max_tokens = options.maxTokens;
    } else {
      request.max_tokens = this.defaultMaxTokens;
    }

    if (options.temperature !== undefined) {
      request.temperature = options.temperature;
    }

    // Note: web search is not supported on free models via OpenRouter
    // The useSearch option is accepted but ignored with a debug warning
    if (options.useSearch && this.debug) {
      console.warn("[OpenRouter] useSearch=true requested but web search is not available on free models");
    }

    return request;
  }

  /**
   * Build request for structured output using native JSON Schema.
   */
  private buildStructuredRequest<T>(
    prompt: string,
    schema: z.ZodSchema<T>,
    options: AICompleteOptions = {}
  ): OpenRouterRequest {
    const baseRequest = this.buildRequest(prompt, options);

    // Convert Zod schema to JSON Schema for OpenRouter's response_format
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
      // When using response_format, some models need temperature=0 for deterministic output
      temperature: options.temperature ?? 0,
    };
  }

  /**
   * Convert Zod schema to JSON Schema (subset supported by OpenRouter).
   * This is a simplified converter for common cases.
   */
  private zodToJsonSchema(schema: z.ZodSchema): object {
    // Handle Zod effects (refinements, transforms) by unwrapping
    // Use type alias for internal Zod schema traversal (_def is internal but accessible at runtime)
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
          // Check if field is optional
          const valueDef = (value as ZodSchemaInternal)._def;
          if (valueDef.typeName !== "ZodOptional" && valueDef.typeName !== "ZodNullable") {
            required.push(key);
          }
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
        // OpenRouter doesn't support union directly; use anyOf
        return {
          anyOf: (def.options ?? []).map((opt: z.ZodSchema) => this.zodToJsonSchema(opt)),
        };
      }

      case "ZodDefault": {
        return def.innerType ? this.zodToJsonSchema(def.innerType) : { type: "object", additionalProperties: true };
      }

      default: {
        // Fallback for unsupported types
        if (this.debug) {
          console.warn(`[OpenRouter] Unsupported Zod type: ${def.typeName}, using empty object schema`);
        }
        return { type: "object", additionalProperties: true };
      }
    }
  }

  /**
   * Make HTTP request to OpenRouter API with retry logic.
   */
  private async requestWithRetry<T>(
    requestBody: OpenRouterRequest,
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
          console.log(`[OpenRouter] Rate limited or server error, waiting ${waitMs / 1000}s before retry ${attempt}...`);
        }
        try {
          await new Promise<void>((resolve, reject) => {
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
              provider: "openrouter",
            });
          }
          throw err;
        }
      }

      try {
        const response = await fetch(this.baseUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${this.apiKey}`,
            // Optional: identify the application for OpenRouter analytics
            "HTTP-Referer": "https://curriculum-generator-alpha.vercel.app",
            "X-Title": "Curriculum Generator",
          },
          body: JSON.stringify(requestBody),
          signal,
        });

        // Handle rate limiting (429)
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
            provider: "openrouter",
          });
          // If Retry-After provided, use it instead of default backoff
          if (retryAfter > 0) {
            if (this.debug) {
              console.log(`[OpenRouter] Server sent Retry-After: ${retryAfter}ms`);
            }
            await new Promise<void>((resolve, reject) => {
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

        // Handle other non-OK responses
        if (!response.ok) {
          const errorText = await response.text();
          let errorCode: AIErrorCode = "UNKNOWN_ERROR";
          let retryable = false;

          if (response.status === 401) {
            errorCode = "AUTH_ERROR";
          } else if (response.status === 400) {
            errorCode = "INVALID_REQUEST";
          } else if (response.status === 402) {
            // OpenRouter specific: insufficient credits
            errorCode = "MODEL_ERROR";
            retryable = false;
          } else if (response.status >= 500) {
            errorCode = "MODEL_ERROR";
            retryable = true;
          }

          lastError = new AIError(errorCode, `OpenRouter API error (${response.status}): ${errorText}`, {
            statusCode: response.status,
            retryable,
            provider: "openrouter",
          });

          if (!retryable) {
            throw lastError;
          }
          continue;
        }

        const data = await response.json() as OpenRouterResponse;
        return data as T;
      } catch (err) {
        if (err instanceof AIError) {
          throw err;
        }
        // Handle AbortError from fetch (signal aborted)
        if (err instanceof DOMException && err.name === "AbortError") {
          throw new AIError("ABORTED", "Request aborted", {
            retryable: false,
            provider: "openrouter",
          });
        }
        lastError = new AIError("NETWORK_ERROR", `Network error: ${err instanceof Error ? err.message : String(err)}`, {
          retryable: true,
          provider: "openrouter",
        });
        if (attempt === maxAttempts - 1) {
          throw lastError;
        }
      }
    }

    throw lastError ?? new AIError("UNKNOWN_ERROR", "Max retries exceeded", {
      provider: "openrouter",
    });
  }

  /**
   * Extract text content from OpenRouter response.
   */
  private extractText(response: OpenRouterResponse): string {
    const choice = response.choices[0];
    if (!choice) {
      throw new Error("No choices in OpenRouter response");
    }
    return choice.message.content ?? "";
  }

  /**
   * Extract and parse JSON from structured response.
   * With response_format, the content should already be valid JSON.
   */
  private extractStructuredJson<T>(response: OpenRouterResponse): T {
    const text = this.extractText(response);
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
   */
  async complete(prompt: string, options: AICompleteOptions = {}): Promise<AICompleteResult> {
    const request = this.buildRequest(prompt, options);
    const response = await this.requestWithRetry<OpenRouterResponse>(request, 4, options.signal);

    const text = this.extractText(response);

    return {
      text,
      usage: response.usage ? {
        inputTokens: response.usage.prompt_tokens,
        outputTokens: response.usage.completion_tokens,
      } : undefined,
      raw: this.debug ? response : undefined,
    };
  }

  /**
   * Generate structured output with native JSON Schema validation.
   * Uses OpenRouter's response_format for guaranteed valid JSON.
   */
  async structured<T>(prompt: string, options: AIStructuredOptions<T>): Promise<AIStructuredResult<T>> {
    const { schema, ...completeOptions } = options;

    const request = this.buildStructuredRequest(prompt, schema, completeOptions);
    const response = await this.requestWithRetry<OpenRouterResponse>(request);

    const rawText = this.extractText(response);

    // Parse JSON (should be valid due to response_format)
    let parsedJson: T;
    try {
      parsedJson = this.extractStructuredJson<T>(response);
    } catch (err) {
      throw new AIError("INVALID_REQUEST", `Failed to parse structured response: ${err instanceof Error ? err.message : String(err)}`, {
        provider: "openrouter",
      });
    }

    // Validate against Zod schema as additional safety
    const result = schema.safeParse(parsedJson);
    if (!result.success) {
      const errorMessages = result.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");
      throw new AIError("INVALID_REQUEST", `Schema validation failed: ${errorMessages}`, {
        provider: "openrouter",
      });
    }

    return {
      data: result.data,
      rawText,
      usage: response.usage ? {
        inputTokens: response.usage.prompt_tokens,
        outputTokens: response.usage.completion_tokens,
      } : undefined,
    };
  }
}