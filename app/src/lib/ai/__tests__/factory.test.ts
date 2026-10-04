/**
 * Tests for AI Provider Factory
 */

import { getAIProvider, createProvider, resetAIProvider, setAIProvider } from "../factory";
import { MockProvider, AnthropicProvider } from "../index";

describe("AI Provider Factory", () => {
  beforeEach(() => {
    resetAIProvider();
    // Clear env vars that might affect provider selection
    delete process.env.AI_PROVIDER;
    delete process.env.ANTHROPIC_API_KEY;
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

  test("createProvider throws for unknown provider", () => {
    expect(() => createProvider({ provider: "unknown" as "anthropic" | "mock" })).toThrow("Unknown AI provider");
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
});