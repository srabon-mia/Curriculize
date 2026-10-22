/**
 * AI Provider Factory
 * Creates and configures provider instances based on environment.
 */

import { AIProvider, AIProviderConfig } from "./types";
import { AnthropicProvider } from "./anthropic";
import { MockProvider } from "./mock";
import { OpenRouterProvider } from "./openrouter";

let cachedProvider: AIProvider | null = null;
let cachedConfig: AIProviderConfig | null = null;

/**
 * Get or create the AI provider instance.
 * Uses singleton pattern for production, but allows override for testing.
 * If config is not explicitly provided and a provider was set via setAIProvider(),
 * returns that explicitly set provider.
 */
export function getAIProvider(config?: Partial<AIProviderConfig>): AIProvider {
  // If explicitly set via setAIProvider() and no config override requested, return it.
  // setAIProvider sets cachedConfig with ONLY the provider field (minimal config),
  // while env resolution creates a full config. Detect explicit injection by checking
  // if cachedConfig has only the provider field.
  const isExplicitInjection = cachedProvider !== null && cachedConfig !== null &&
    Object.keys(cachedConfig).length === 1 && "provider" in cachedConfig;
  if (config === undefined && isExplicitInjection) {
    return cachedProvider!;
  }

  // Resolve config from environment (reads current env vars to detect changes)
  const resolvedProvider = config?.provider ?? (process.env.AI_PROVIDER as "anthropic" | "mock" | "openrouter") ?? "anthropic";
  const resolvedConfig: AIProviderConfig = {
    provider: resolvedProvider,
    apiKey: config?.apiKey ??
      (resolvedProvider === "openrouter" ? process.env.OPENROUTER_API_KEY : process.env.ANTHROPIC_API_KEY),
    defaultModel: config?.defaultModel ?? process.env.AI_DEFAULT_MODEL,
    defaultMaxTokens: config?.defaultMaxTokens ? parseInt(process.env.AI_DEFAULT_MAX_TOKENS ?? "", 10) : undefined,
    debug: config?.debug ?? process.env.AI_DEBUG === "true",
  };

  // Fail fast if required API key is missing for the selected provider
  if (resolvedProvider === "anthropic" && !resolvedConfig.apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required but not set. Set AI_PROVIDER=openrouter to use OpenRouter instead.");
  }
  if (resolvedProvider === "openrouter" && !resolvedConfig.apiKey) {
    throw new Error("OPENROUTER_API_KEY is required but not set. Set AI_PROVIDER=openrouter and provide OPENROUTER_API_KEY.");
  }

  // Return cached provider if config matches (handles env var changes)
  if (cachedProvider && configsEqual(cachedConfig, resolvedConfig)) {
    return cachedProvider;
  }

  // Create new provider
  cachedProvider = createProvider(resolvedConfig);
  cachedConfig = resolvedConfig;
  return cachedProvider;
}

/**
 * Create a provider instance from config.
 * Does not cache - use getAIProvider() for cached singleton.
 */
export function createProvider(config: AIProviderConfig): AIProvider {
  switch (config.provider) {
    case "anthropic":
      if (!config.apiKey) {
        throw new Error("ANTHROPIC_API_KEY is required for anthropic provider");
      }
      return new AnthropicProvider({
        apiKey: config.apiKey,
        defaultModel: config.defaultModel,
        defaultMaxTokens: config.defaultMaxTokens,
        debug: config.debug,
      });

    case "openrouter":
      if (!config.apiKey) {
        throw new Error("OPENROUTER_API_KEY is required for openrouter provider");
      }
      return new OpenRouterProvider({
        apiKey: config.apiKey,
        defaultModel: config.defaultModel,
        defaultMaxTokens: config.defaultMaxTokens,
        debug: config.debug,
      });

    case "mock":
      return new MockProvider();

    default:
      throw new Error(`Unknown AI provider: ${(config as AIProviderConfig).provider}`);
  }
}

/**
 * Reset the cached provider (primarily for testing).
 */
export function resetAIProvider(): void {
  cachedProvider = null;
  cachedConfig = null;
}

/**
 * Set a specific provider instance (for testing dependency injection).
 */
export function setAIProvider(provider: AIProvider): void {
  cachedProvider = provider;
  cachedConfig = { provider: provider.name as "anthropic" | "mock" };
}

/**
 * Compare two configs for equality (for caching).
 */
function configsEqual(a: AIProviderConfig | null, b: AIProviderConfig): boolean {
  if (!a) return false;
  return (
    a.provider === b.provider &&
    a.apiKey === b.apiKey &&
    a.defaultModel === b.defaultModel &&
    a.defaultMaxTokens === b.defaultMaxTokens &&
    a.debug === b.debug
  );
}