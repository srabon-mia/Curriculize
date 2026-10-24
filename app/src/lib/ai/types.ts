/**
 * AI Provider Abstraction - Core Types
 * Provider-agnostic types for structured AI interaction.
 */

import { z } from "zod";

/**
 * Standardized error codes across providers.
 */
export type AIErrorCode =
  | "RATE_LIMITED"
  | "AUTH_ERROR"
  | "INVALID_REQUEST"
  | "MODEL_ERROR"
  | "NETWORK_ERROR"
  | "UNKNOWN_ERROR"
  | "ABORTED";

/**
 * Provider-agnostic error class.
 */
export class AIError extends Error {
  public readonly code: AIErrorCode;
  public readonly statusCode?: number;
  public readonly retryable: boolean;
  public readonly provider?: string;
  public readonly providerErrorCode?: string;

  constructor(
    code: AIErrorCode,
    message: string,
    options: { statusCode?: number; retryable?: boolean; provider?: string; providerErrorCode?: string } = {}
  ) {
    super(message);
    this.name = "AIError";
    this.code = code;
    this.statusCode = options.statusCode;
    this.retryable = options.retryable ?? false;
    this.provider = options.provider;
    this.providerErrorCode = options.providerErrorCode;
  }
}

/**
 * Options for AI completion requests.
 */
export interface AICompleteOptions {
  /** Maximum tokens in response */
  maxTokens?: number;
  /** Temperature for sampling (0-1) */
  temperature?: number;
  /** Whether to enable web search tool */
  useSearch?: boolean;
  /** Model name (provider-specific) */
  model?: string;
  /** System prompt */
  systemPrompt?: string;
  /** Optional AbortSignal for cancellation */
  signal?: AbortSignal;
  /** Optional timeout in milliseconds (alternative to signal) */
  timeoutMs?: number;
  /** Safe identifiers for correlating provider diagnostics without logging prompts. */
  diagnostics?: {
    curriculumId?: string;
    jobId?: string;
    streamId?: string;
    operation?: string;
    topicId?: string;
    attemptNumber?: number;
  };
}

/**
 * Options for structured output requests.
 */
export interface AIStructuredOptions<T> extends AICompleteOptions {
  /** Zod schema for response validation */
  schema: z.ZodSchema<T>;
}

/**
 * Search citation from web search tool.
 */
export interface AISearchCitation {
  /** URL of the cited source */
  url: string;
  /** Title of the cited source */
  title?: string;
  /** Snippet or excerpt from the source */
  snippet?: string;
}

/**
 * Raw completion result.
 */
export interface AICompleteResult {
  /** The generated text content */
  text: string;
  /** Token usage if available */
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
  /** Raw provider response for debugging */
  raw?: unknown;
  /** Search citations if web search was used */
  searchCitations?: AISearchCitation[];
  /** Whether the web search tool completed successfully (only set when useSearch=true) */
  searchCompleted?: boolean;
}

/**
 * Structured output result with validation.
 */
export interface AIStructuredResult<T> {
  /** Validated parsed data */
  data: T;
  /** Raw text before parsing */
  rawText: string;
  /** Token usage if available */
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
  /** Search results used to ground this structured response, when useSearch=true */
  searchCitations?: AISearchCitation[];
  /** Whether the required web search completed before structured generation */
  searchCompleted?: boolean;
}

/**
 * Provider capability flags.
 */
export interface AIProviderCapabilities {
  /** Supports structured output with schema validation */
  structuredOutput: boolean;
  /** Supports web search tool */
  webSearch: boolean;
  /** Supports streaming */
  streaming: boolean;
}

/**
 * Base AI Provider interface.
 * All provider implementations must satisfy this contract.
 */
export interface AIProvider {
  /** Provider identifier */
  readonly name: string;
  /** Provider capabilities */
  readonly capabilities: AIProviderCapabilities;

  /**
   * Generate a text completion.
   */
  complete(prompt: string, options?: AICompleteOptions): Promise<AICompleteResult>;

  /**
   * Generate structured output validated against a schema.
   * Implementations should use native structured output where available,
   * or fall back to prompt-based JSON extraction with validation.
   */
  structured<T>(prompt: string, options: AIStructuredOptions<T>): Promise<AIStructuredResult<T>>;
}

/**
 * Configuration for provider factory.
 */
export interface AIProviderConfig {
  /** Provider name: "anthropic" | "mock" | "openrouter" | "azure" */
  provider: "anthropic" | "mock" | "openrouter" | "azure";
  /** API key (required for anthropic, openrouter, and azure providers) */
  apiKey?: string;
  /** Default model name */
  defaultModel?: string;
  /** Default max tokens */
  defaultMaxTokens?: number;
  /** Enable debug logging */
  debug?: boolean;
}
