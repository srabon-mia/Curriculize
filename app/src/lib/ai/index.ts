/**
 * AI Provider Abstraction - Public API
 * Export all public types and factory functions.
 */

// Types
export type {
  AIErrorCode,
  AICompleteOptions,
  AIStructuredOptions,
  AICompleteResult,
  AIStructuredResult,
  AIProviderCapabilities,
  AIProviderConfig,
} from "./types";

export type { AIError, AIProvider } from "./types";

// Implementations
export { AnthropicProvider } from "./anthropic";
export { MockProvider, createMockProvider, type MockCallRecord, type MockResponse } from "./mock";

// Factory
export { getAIProvider, createProvider, resetAIProvider, setAIProvider } from "./factory";