/**
 * Anthropic Provider Adapter
 * Implements AIProvider interface for Anthropic Claude API.
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

const ANTHROPIC_API_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_MAX_TOKENS = 4000;
const DEFAULT_BASE_URL = "https://api.anthropic.com/v1/messages";

const WEB_SEARCH_TOOL = {
  type: "web_search_20250305",
  name: "web_search",
} as const;

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string;
}

interface AnthropicRequest {
  model: string;
  max_tokens: number;
  temperature?: number;
  system?: string;
  tools?: Array<{ type: string; name: string }>;
  messages: AnthropicMessage[];
}

interface AnthropicResponse {
  id: string;
  type: string;
  role: string;
  content: Array<{
    type: "text" | "tool_use" | "tool_result";
    text?: string;
    id?: string;
    name?: string;
    input?: unknown;
  }>;
  model: string;
  stop_reason: string;
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

interface AnthropicErrorResponse {
  type: string;
  error: {
    type: string;
    message: string;
  };
}

/**
 * Anthropic provider implementation.
 */
export class AnthropicProvider implements AIProvider {
  public readonly name = "anthropic";
  public readonly capabilities: AIProviderCapabilities = {
    structuredOutput: false, // Uses prompt-based JSON extraction with validation
    webSearch: true,
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
      throw new Error("Anthropic API key is required");
    }
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.defaultModel = config.defaultModel ?? DEFAULT_MODEL;
    this.defaultMaxTokens = config.defaultMaxTokens ?? DEFAULT_MAX_TOKENS;
    this.debug = config.debug ?? false;
    this.retryDelayMs = config.retryDelayMs ?? ((attempt: number) => attempt * 30_000);
  }

  /**
   * Build the request body for Anthropic API.
   */
  private buildRequest(prompt: string, options: AICompleteOptions = {}): AnthropicRequest {
    const useSearch = options.useSearch ?? false;
    const messages: AnthropicMessage[] = [{ role: "user", content: prompt }];

    const request: AnthropicRequest = {
      model: options.model ?? this.defaultModel,
      max_tokens: options.maxTokens ?? this.defaultMaxTokens,
      messages,
    };

    if (options.temperature !== undefined) {
      request.temperature = options.temperature;
    }

    if (options.systemPrompt) {
      request.system = options.systemPrompt;
    }

    if (useSearch) {
      request.tools = [WEB_SEARCH_TOOL];
    }

    return request;
  }

  /**
   * Make HTTP request to Anthropic API with retry logic.
   */
  private async requestWithRetry<T>(
    requestBody: AnthropicRequest,
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
          console.log(`[Anthropic] Rate limited, waiting ${waitMs / 1000}s before retry ${attempt}...`);
        }
        try {
          await new Promise((resolve, reject) => {
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
              provider: "anthropic",
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
            "x-api-key": this.apiKey,
            "anthropic-version": ANTHROPIC_API_VERSION,
          },
          body: JSON.stringify(requestBody),
          signal,
        });

        if (response.status === 429) {
          const errorText = await response.text();
          lastError = new AIError("RATE_LIMITED", `Rate limited: ${errorText}`, {
            statusCode: 429,
            retryable: true,
            provider: "anthropic",
          });
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
          } else if (response.status >= 500) {
            errorCode = "MODEL_ERROR";
            retryable = true;
          }

          lastError = new AIError(errorCode, `Anthropic API error (${response.status}): ${errorText}`, {
            statusCode: response.status,
            retryable,
            provider: "anthropic",
          });

          if (!retryable) {
            throw lastError;
          }
          continue;
        }

        const data = await response.json() as AnthropicResponse;
        return data as T;
      } catch (err) {
        if (err instanceof AIError) {
          throw err;
        }
        lastError = new AIError("NETWORK_ERROR", `Network error: ${err instanceof Error ? err.message : String(err)}`, {
          retryable: true,
          provider: "anthropic",
        });
        if (attempt === maxAttempts - 1) {
          throw lastError;
        }
      }
    }

    throw lastError ?? new AIError("UNKNOWN_ERROR", "Max retries exceeded", {
      provider: "anthropic",
    });
  }

  /**
   * Extract text content from Anthropic response.
   */
  private extractText(response: AnthropicResponse): string {
    const textBlocks = response.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text);
    return textBlocks.join("");
  }

  /**
   * Extract JSON from text using the same pattern as existing code.
   * Tries array first, then object.
   */
  private extractJson(text: string): unknown {
    // Try array first
    let match = text.match(/\[[\s\S]*\]/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        // Fall through to object attempt
      }
    }

    // Try object
    match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        // If it's an object with an array value, return that array
        if (typeof parsed === "object" && parsed !== null) {
          const arrayValue = Object.values(parsed).find((v) => Array.isArray(v));
          if (arrayValue) {
            return arrayValue;
          }
        }
        return parsed;
      } catch {
        // Fall through
      }
    }

    throw new Error("No valid JSON found in response");
  }

  /**
   * Generate a text completion.
   */
  async complete(prompt: string, options: AICompleteOptions = {}): Promise<AICompleteResult> {
    const request = this.buildRequest(prompt, options);
    const response = await this.requestWithRetry<AnthropicResponse>(request, 4, options.signal);

    const text = this.extractText(response);

    return {
      text,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
      raw: this.debug ? response : undefined,
    };
  }

  /**
   * Generate structured output with schema validation.
   * Uses prompt-based JSON extraction with Zod validation.
   */
  async structured<T>(prompt: string, options: AIStructuredOptions<T>): Promise<AIStructuredResult<T>> {
    const { schema, ...completeOptions } = options;

    // Add instruction for JSON output
    const structuredPrompt = `${prompt}\n\nReturn ONLY valid JSON. No markdown, no explanation, no additional text.`;

    const request = this.buildRequest(structuredPrompt, completeOptions);
    const response = await this.requestWithRetry<AnthropicResponse>(request, 4, completeOptions.signal);

    const rawText = this.extractText(response);

    // Extract JSON from response
    let parsedJson: unknown;
    try {
      parsedJson = this.extractJson(rawText);
    } catch (err) {
      throw new AIError("INVALID_REQUEST", `Failed to extract JSON from response: ${err instanceof Error ? err.message : String(err)}`, {
        provider: "anthropic",
      });
    }

    // Validate against schema
    const result = schema.safeParse(parsedJson);
    if (!result.success) {
      const errorMessages = result.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");
      throw new AIError("INVALID_REQUEST", `Schema validation failed: ${errorMessages}`, {
        provider: "anthropic",
      });
    }

    return {
      data: result.data,
      rawText,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }
}
