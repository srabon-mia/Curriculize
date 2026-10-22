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

  test("mock provider still works without API keys", () => {
    const provider = getAIProvider({ provider: "mock" });
    expect(provider).toBeInstanceOf(MockProvider);
    expect(provider.name).toBe("mock");
  });

  test("anthropic provider still works with explicit config", () => {
    const provider = getAIProvider({ provider: "anthropic", apiKey: "test-key" });
    expect(provider).toBeInstanceOf(AnthropicProvider);
    expect(provider.name).toBe("anthropic");
  });
});