/**
 * AI Provider Factory
 * Creates and configures provider instances based on environment.
 */

import { AIProvider, AIProviderConfig } from "./types";
import { AnthropicProvider } from "./anthropic";
import { MockProvider } from "./mock";
import { OpenRouterProvider } from "./openrouter";
import { AzureProvider } from "./azure";

let cachedProvider: AIProvider | null = null;
let cachedConfig: AIProviderConfig | null = null;

/**
 * Get or create the AI provider instance.
 * Uses singleton pattern for production, but allows override for testing.
 * If config is not explicitly provided and a provider was set via setAIProvider(),
 * returns that explicitly set provider.
 */
export function getAIProvider(
  config?: Partial<AIProviderConfig>,
  context: { operation?: string } = {}
): AIProvider {
  // If explicitly set via setAIProvider() and no config override requested, return it.
  // setAIProvider sets cachedConfig with ONLY the provider field (minimal config),
  // while env resolution creates a full config. Detect explicit injection by checking
  // if cachedConfig has only the provider field.
  const isExplicitInjection = cachedProvider !== null && cachedConfig !== null &&
    Object.keys(cachedConfig).length === 1 && "provider" in cachedConfig;
  if (config === undefined && isExplicitInjection) {
    console.info(
      `[ai] Provider selected: provider=${cachedProvider!.name}, reason=setAIProvider injection, operation=${context.operation ?? "unspecified"}`
    );
    return cachedProvider!;
  }

  // Resolve config from environment (reads current env vars to detect changes)
  const resolvedProvider = config?.provider ?? (process.env.AI_PROVIDER as "anthropic" | "mock" | "openrouter" | "azure") ?? "anthropic";
  let resolvedApiKey: string | undefined;
  if (config?.apiKey) {
    resolvedApiKey = config.apiKey;
  } else if (resolvedProvider === "openrouter") {
    resolvedApiKey = process.env.OPENROUTER_API_KEY;
  } else if (resolvedProvider === "azure") {
    resolvedApiKey = process.env.AZURE_OPENAI_API_KEY;
  } else {
    resolvedApiKey = process.env.ANTHROPIC_API_KEY;
  }

  const resolvedConfig: AIProviderConfig = {
    provider: resolvedProvider,
    apiKey: resolvedApiKey,
    defaultModel: config?.defaultModel ?? process.env.AI_DEFAULT_MODEL,
    defaultMaxTokens: config?.defaultMaxTokens ? parseInt(process.env.AI_DEFAULT_MAX_TOKENS ?? "", 10) : undefined,
    debug: config?.debug ?? process.env.AI_DEBUG === "true",
  };

  // Fail fast if required API key is missing for the selected provider
  if (resolvedProvider === "anthropic" && !resolvedConfig.apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required but not set. Set AI_PROVIDER=openrouter or AI_PROVIDER=azure to use another provider.");
  }
  if (resolvedProvider === "openrouter" && !resolvedConfig.apiKey) {
    throw new Error("OPENROUTER_API_KEY is required but not set. Set AI_PROVIDER=openrouter and provide OPENROUTER_API_KEY.");
  }
  if (resolvedProvider === "azure" && !resolvedConfig.apiKey) {
    throw new Error("AZURE_OPENAI_API_KEY is required but not set. Set AI_PROVIDER=azure and provide AZURE_OPENAI_API_KEY, AZURE_OPENAI_ENDPOINT, and AZURE_OPENAI_DEPLOYMENT.");
  }

  // Return cached provider if config matches (handles env var changes)
  if (cachedProvider && configsEqual(cachedConfig, resolvedConfig)) {
    const selectionReason = config?.provider
      ? "explicit config"
      : process.env.AI_PROVIDER
        ? "AI_PROVIDER environment"
        : "default provider";
    console.info(
      `[ai] Provider selected: provider=${cachedProvider.name}, reason=${selectionReason}, operation=${context.operation ?? "unspecified"}`
    );
    return cachedProvider;
  }

  // Create new provider
  cachedProvider = createProvider(resolvedConfig);
  cachedConfig = resolvedConfig;
  const selectionReason = config?.provider
    ? "explicit config"
    : process.env.AI_PROVIDER
      ? "AI_PROVIDER environment"
      : "default provider";
  console.info(
    `[ai] Provider selected: provider=${cachedProvider.name}, reason=${selectionReason}, operation=${context.operation ?? "unspecified"}`
  );
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

    case "azure":
      if (!config.apiKey) {
        throw new Error("AZURE_OPENAI_API_KEY is required for azure provider");
      }
      // Azure-specific config from environment (not in AIProviderConfig to keep it generic)
      const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
      const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;
      const apiVersion = process.env.AZURE_OPENAI_API_VERSION;
      const useV1Endpoint = process.env.AZURE_OPENAI_USE_V1_ENDPOINT === "true";

      if (!endpoint) {
        throw new Error("AZURE_OPENAI_ENDPOINT is required for azure provider (e.g., https://my-resource.openai.azure.com)");
      }
      if (!deployment) {
        throw new Error("AZURE_OPENAI_DEPLOYMENT is required for azure provider (deployment name, e.g., gpt-4.1-mini)");
      }

      return new AzureProvider({
        apiKey: config.apiKey,
        endpoint,
        deployment,
        apiVersion,
        defaultModel: config.defaultModel,
        defaultMaxTokens: config.defaultMaxTokens,
        debug: config.debug,
        useV1Endpoint,
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
