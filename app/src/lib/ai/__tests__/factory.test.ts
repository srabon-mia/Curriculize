/**
 * Tests for AI Provider Factory
 */

import { getAIProvider, createProvider, resetAIProvider, setAIProvider } from "../factory";
import { MockProvider, AnthropicProvider, OpenRouterProvider } from "../index";

describe("AI Provider Factory", () => {
  beforeEach(() => {
    resetAIProvider();
    // Clear env vars that might affect provider selection
    delete process.env.AI_PROVIDER;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.AI_DEFAULT_MODEL;
    delete process.env.AI_DEBUG;
  });

  afterEach(() => {
    resetAIProvider();
  });

  test("createProvider creates MockProvider", () => {
    const provider = createProvider({ provider: "mock" });
    expect(provider).toBeInstanceOf(MockProvider);
    expect(provider.name).toBe("mock");
  });

  test("createProvider creates AnthropicProvider with api key", () => {
    const provider = createProvider({
      provider: "anthropic",
      apiKey: "test-key",
    });
    expect(provider).toBeInstanceOf(AnthropicProvider);
    expect(provider.name).toBe("anthropic");
  });

  test("createProvider throws for anthropic without api key", () => {
    expect(() => createProvider({ provider: "anthropic" })).toThrow("ANTHROPIC_API_KEY is required");
  });

  test("createProvider creates OpenRouterProvider with api key", () => {
    const provider = createProvider({
      provider: "openrouter",
      apiKey: "test-openrouter-key",
    });
    expect(provider).toBeInstanceOf(OpenRouterProvider);
    expect(provider.name).toBe("openrouter");
  });

  test("createProvider throws for openrouter without api key", () => {
    expect(() => createProvider({ provider: "openrouter" })).toThrow("OPENROUTER_API_KEY is required");
  });

  test("createProvider throws for unknown provider", () => {
    expect(() => createProvider({ provider: "unknown" as "anthropic" | "mock" | "openrouter" })).toThrow("Unknown AI provider");
  });

  test("getAIProvider returns cached instance for same config", () => {
    const provider1 = getAIProvider({ provider: "mock" });
    const provider2 = getAIProvider({ provider: "mock" });
    expect(provider1).toBe(provider2);
  });

  test("getAIProvider creates new instance for different config", () => {
    const provider1 = getAIProvider({ provider: "mock" });
    const provider2 = getAIProvider({ provider: "anthropic", apiKey: "key1" });
    expect(provider1).not.toBe(provider2);
  });

  test("resetAIProvider clears cache", () => {
    const provider1 = getAIProvider({ provider: "mock" });
    resetAIProvider();
    const provider2 = getAIProvider({ provider: "mock" });
    expect(provider1).not.toBe(provider2);
  });

  test("setAIProvider allows direct injection for testing", () => {
    const mockProvider = new MockProvider();
    setAIProvider(mockProvider);

    const provider = getAIProvider();
    expect(provider).toBe(mockProvider);
  });

  test("environment variable AI_PROVIDER selects provider", () => {
    process.env.AI_PROVIDER = "mock";
    const provider = getAIProvider();
    expect(provider.name).toBe("mock");
  });

  test("anthropic provider uses ANTHROPIC_API_KEY from env", () => {
    process.env.ANTHROPIC_API_KEY = "env-key";
    process.env.AI_PROVIDER = "anthropic";
    const provider = getAIProvider();
    expect(provider).toBeInstanceOf(AnthropicProvider);
  });

  // --- Regression tests for provider selection fix ---

  test("openrouter provider uses OPENROUTER_API_KEY from env when AI_PROVIDER=openrouter", () => {
    process.env.OPENROUTER_API_KEY = "env-openrouter-key";
    process.env.AI_PROVIDER = "openrouter";
    const provider = getAIProvider();
    expect(provider).toBeInstanceOf(OpenRouterProvider);
  });

  test("factory fails fast when AI_PROVIDER=openrouter but OPENROUTER_API_KEY is missing", () => {
    process.env.AI_PROVIDER = "openrouter";
    // OPENROUTER_API_KEY not set
    expect(() => getAIProvider()).toThrow("OPENROUTER_API_KEY is required but not set");
  });

  test("factory fails fast when AI_PROVIDER=anthropic but ANTHROPIC_API_KEY is missing", () => {
    process.env.AI_PROVIDER = "anthropic";
    // ANTHROPIC_API_KEY not set
    expect(() => getAIProvider()).toThrow("ANTHROPIC_API_KEY is required but not set");
  });

  test("explicit config overrides environment variables for provider and apiKey", () => {
    process.env.AI_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "env-anthropic-key";
    // Explicit config should override env
    const provider = getAIProvider({ provider: "openrouter", apiKey: "explicit-openrouter-key" });
    expect(provider.name).toBe("openrouter");
  });

  test("apiKey resolution uses resolved provider, not raw AI_PROVIDER env var", () => {
    // This test verifies the fix for the bug where apiKey was selected based on
    // raw process.env.AI_PROVIDER instead of the resolved provider value.
    // Scenario: AI_PROVIDER=openrouter but explicit config.provider=anthropic with explicit apiKey
    process.env.AI_PROVIDER = "openrouter";
    process.env.OPENROUTER_API_KEY = "env-openrouter-key";
    process.env.ANTHROPIC_API_KEY = "env-anthropic-key";

    // Explicit anthropic config should use the explicit anthropic apiKey, not OPENROUTER_API_KEY
    const provider = getAIProvider({ provider: "anthropic", apiKey: "explicit-anthropic-key" });
    expect(provider).toBeInstanceOf(AnthropicProvider);
    // The provider should have been created with the explicit key, not the env var
    // We can't directly inspect the key, but we verify the right provider type is created
  });

  test("switching providers via env var creates new instance", () => {
    process.env.AI_PROVIDER = "openrouter";
    process.env.OPENROUTER_API_KEY = "key1";
    const provider1 = getAIProvider();

    resetAIProvider();

    process.env.AI_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "key2";
    const provider2 = getAIProvider();

    expect(provider1.name).toBe("openrouter");
    expect(provider2.name).toBe("anthropic");
    expect(provider1).not.toBe(provider2);
  });

  // --- Regression test for caching bug ---
  // The factory must re-read env vars on each getAIProvider() call when no explicit config
  // is provided, so that a container reuse with changed env vars doesn't return a stale provider.

  test("factory re-reads AI_PROVIDER on each call and creates new provider when env changes", () => {
    // Simulate first cold start: AI_PROVIDER not set -> defaults to anthropic
    delete process.env.AI_PROVIDER;
    process.env.ANTHROPIC_API_KEY = "key1";
    const provider1 = getAIProvider();
    expect(provider1.name).toBe("anthropic");

    // Simulate container reuse: env var changed to openrouter, but module cache persists
    // The factory must detect this and create a new provider
    process.env.AI_PROVIDER = "openrouter";
    process.env.OPENROUTER_API_KEY = "key2";
    // Don't call resetAIProvider() - simulates same module instance
    const provider2 = getAIProvider();
    expect(provider2.name).toBe("openrouter");
    expect(provider2).not.toBe(provider1); // Must be a new instance
  });

  test("factory returns cached provider when env vars unchanged", () => {
    process.env.AI_PROVIDER = "openrouter";
    process.env.OPENROUTER_API_KEY = "key1";
    const provider1 = getAIProvider();
    const provider2 = getAIProvider(); // Second call without env change
    expect(provider2).toBe(provider1); // Should return cached instance
  });

  // --- Production scenario regression tests ---

  test("production: AI_PROVIDER=openrouter with valid OPENROUTER_API_KEY returns OpenRouterProvider", () => {
    // Exact production configuration
    process.env.AI_PROVIDER = "openrouter";
    process.env.OPENROUTER_API_KEY = "sk-or-v1-production-key";
    process.env.ANTHROPIC_API_KEY = "sk-ant-old-key"; // Old key present but should be ignored

    const provider = getAIProvider();
    expect(provider).toBeInstanceOf(OpenRouterProvider);
    expect(provider.name).toBe("openrouter");
  });

  test("production: AI_PROVIDER=openrouter fails clearly when OPENROUTER_API_KEY missing", () => {
    process.env.AI_PROVIDER = "openrouter";
    // OPENROUTER_API_KEY deliberately not set
    process.env.ANTHROPIC_API_KEY = "sk-ant-old-key";

    expect(() => getAIProvider()).toThrow("OPENROUTER_API_KEY is required but not set");
  });

  test("isExplicitInjection heuristic: explicit setAIProvider is detected correctly", () => {
    const mockProvider = new MockProvider();
    setAIProvider(mockProvider);

    // Should return injected provider without checking env vars
    const provider = getAIProvider();
    expect(provider).toBe(mockProvider);
  });

  test("isExplicitInjection heuristic: env-resolved provider is NOT treated as explicit injection", () => {
    // First, create a provider via env resolution
    process.env.AI_PROVIDER = "openrouter";
    process.env.OPENROUTER_API_KEY = "key1";
    const provider1 = getAIProvider();
    expect(provider1.name).toBe("openrouter");

    // Change env to anthropic
    process.env.AI_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "key2";

    // Should NOT return the cached openrouter provider (not explicit injection)
    // Should re-resolve and create new anthropic provider
    const provider2 = getAIProvider();
    expect(provider2.name).toBe("anthropic");
    expect(provider2).not.toBe(provider1);
  });

  test("isExplicitInjection heuristic: cachedConfig with full fields is not explicit injection", () => {
    // Verify that a provider created via env resolution has full cachedConfig
    process.env.AI_PROVIDER = "openrouter";
    process.env.OPENROUTER_API_KEY = "key1";
    getAIProvider();

    // The cachedConfig should have all fields (provider, apiKey, defaultModel, defaultMaxTokens, debug)
    // We can't directly access it, but we can verify the behavior:
    // Changing env should create a new provider, not return cached
    process.env.AI_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "key2";

    const provider = getAIProvider();
    expect(provider.name).toBe("anthropic");
  });

  test("factory never instantiates AnthropicProvider when AI_PROVIDER=openrouter", () => {
    // This test verifies that even if ANTHROPIC_API_KEY is present,
    // it is completely ignored when AI_PROVIDER=openrouter
    process.env.AI_PROVIDER = "openrouter";
    process.env.OPENROUTER_API_KEY = "sk-or-v1-test";
    process.env.ANTHROPIC_API_KEY = "sk-ant-any-value";

    const provider = getAIProvider();
    expect(provider).toBeInstanceOf(OpenRouterProvider);
    expect(provider.name).toBe("openrouter");
  });
});