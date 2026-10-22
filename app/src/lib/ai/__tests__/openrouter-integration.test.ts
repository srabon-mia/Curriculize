/**
 * Integration tests for OpenRouter provider via factory.
 */

import { getAIProvider, createProvider, resetAIProvider } from "../factory";
import { OpenRouterProvider, AnthropicProvider, MockProvider } from "../index";
import { AIError } from "../types";

describe("AI Provider Factory - OpenRouter Integration", () => {
  beforeEach(() => {
    resetAIProvider();
    delete process.env.AI_PROVIDER;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.AI_DEFAULT_MODEL;
    delete process.env.AI_DEBUG;
  });

  afterEach(() => {
    resetAIProvider();
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

  test("getAIProvider selects openrouter via AI_PROVIDER env var", () => {
    process.env.AI_PROVIDER = "openrouter";
    process.env.OPENROUTER_API_KEY = "env-openrouter-key";

    const provider = getAIProvider();
    expect(provider.name).toBe("openrouter");
  });

  test("getAIProvider uses OPENROUTER_API_KEY from env for openrouter", () => {
    process.env.AI_PROVIDER = "openrouter";
    process.env.OPENROUTER_API_KEY = "env-openrouter-key";

    const provider = getAIProvider() as OpenRouterProvider;
    // We can't directly test the API key is set, but we can verify it doesn't throw
    expect(provider).toBeInstanceOf(OpenRouterProvider);
  });

  test("getAIProvider ignores AI_DEFAULT_MODEL env var (always uses openrouter/free)", () => {
    process.env.AI_PROVIDER = "openrouter";
    process.env.OPENROUTER_API_KEY = "env-openrouter-key";
    process.env.AI_DEFAULT_MODEL = "custom-free-model";

    expect(() => getAIProvider()).toThrow(AIError);
    expect(() => getAIProvider()).toThrow(/only supports the free model/);
  });

  test("explicit config overrides environment variables", () => {
    process.env.AI_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "env-anthropic-key";

    const provider = getAIProvider({ provider: "openrouter", apiKey: "explicit-key" });
    expect(provider.name).toBe("openrouter");
  });

  test("switching providers creates new instance", () => {
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

  test("mock provider still works", () => {
    const provider = getAIProvider({ provider: "mock" });
    expect(provider).toBeInstanceOf(MockProvider);
    expect(provider.name).toBe("mock");
  });

  test("anthropic provider still works", () => {
    const provider = getAIProvider({ provider: "anthropic", apiKey: "test-key" });
    expect(provider).toBeInstanceOf(AnthropicProvider);
    expect(provider.name).toBe("anthropic");
  });
});