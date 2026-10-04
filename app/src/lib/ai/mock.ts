/**
 * Mock AI Provider
 * Deterministic implementation for testing - no network calls, no API keys.
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

/**
 * Recorded call for test inspection.
 */
export interface MockCallRecord {
  method: "complete" | "structured";
  prompt: string;
  options: AICompleteOptions;
  timestamp: number;
}

/**
 * Configurable mock response.
 */
export interface MockResponse<T = unknown> {
  /** Response data for structured() calls */
  structuredData?: T;
  /** Response text for complete() calls */
  completeText?: string;
  /** Error to throw */
  error?: AIError;
  /** Delay in ms (for testing async behavior) */
  delayMs?: number;
  /** Token usage to report */
  usage?: { inputTokens: number; outputTokens: number };
}

/**
 * Mock AI Provider for testing.
 * Returns deterministic fixtures, records all calls for verification.
 */
export class MockProvider implements AIProvider {
  public readonly name = "mock";
  public readonly capabilities: AIProviderCapabilities = {
    structuredOutput: true,
    webSearch: false,
    streaming: false,
  };

  private responses: Map<string, MockResponse> = new Map();
  private defaultResponse: MockResponse = {
    completeText: '{"result": "mock response"}',
    usage: { inputTokens: 100, outputTokens: 50 },
  };
  public callHistory: MockCallRecord[] = [];
  public callCount = 0;

  /**
   * Set a response for a specific prompt (exact match).
   */
  setResponse(prompt: string, response: MockResponse): void {
    this.responses.set(prompt, response);
  }

  /**
   * Set the default response for any unmatched prompt.
   */
  setDefaultResponse(response: MockResponse): void {
    this.defaultResponse = response;
  }

  /**
   * Clear all recorded calls and configured responses.
   */
  reset(): void {
    this.responses.clear();
    this.callHistory = [];
    this.callCount = 0;
    this.defaultResponse = {
      completeText: '{"result": "mock response"}',
      usage: { inputTokens: 100, outputTokens: 50 },
    };
  }

  /**
   * Get calls matching a predicate.
   */
  getCalls(predicate?: (record: MockCallRecord) => boolean): MockCallRecord[] {
    if (!predicate) return [...this.callHistory];
    return this.callHistory.filter(predicate);
  }

  /**
   * Get the last call.
   */
  getLastCall(): MockCallRecord | undefined {
    return this.callHistory[this.callHistory.length - 1];
  }

  /**
   * Check if a specific prompt was called.
   */
  wasCalledWith(prompt: string): boolean {
    return this.callHistory.some((call) => call.prompt === prompt);
  }

  /**
   * Get call count.
   */
  getCallCount(): number {
    return this.callCount;
  }

  private recordCall(method: "complete" | "structured", prompt: string, options: AICompleteOptions): void {
    this.callCount++;
    this.callHistory.push({
      method,
      prompt,
      options,
      timestamp: Date.now(),
    });
  }

  private getResponse(prompt: string): MockResponse {
    return this.responses.get(prompt) ?? this.defaultResponse;
  }

  private async applyDelay(delayMs?: number): Promise<void> {
    if (delayMs && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  async complete(prompt: string, options: AICompleteOptions = {}): Promise<AICompleteResult> {
    this.recordCall("complete", prompt, options);
    const response = this.getResponse(prompt);
    await this.applyDelay(response.delayMs);

    if (response.error) {
      throw response.error;
    }

    return {
      text: response.completeText ?? this.defaultResponse.completeText ?? "",
      usage: response.usage ?? this.defaultResponse.usage,
    };
  }

  async structured<T>(prompt: string, options: AIStructuredOptions<T>): Promise<AIStructuredResult<T>> {
    this.recordCall("structured", prompt, options);
    const response = this.getResponse(prompt);
    await this.applyDelay(response.delayMs);

    if (response.error) {
      throw response.error;
    }

    const data = response.structuredData;
    if (data === undefined) {
      // Try to parse default completeText as JSON
      const defaultText = this.defaultResponse.completeText ?? '{"result": "mock"}';
      try {
        const parsed = JSON.parse(defaultText);
        const result = options.schema.safeParse(parsed);
        if (!result.success) {
          throw new AIError("INVALID_REQUEST", `Default mock response failed schema validation`, {
            provider: "mock",
          });
        }
        return {
          data: result.data,
          rawText: defaultText,
          usage: this.defaultResponse.usage,
        };
      } catch {
        throw new AIError("INVALID_REQUEST", `No structured mock data configured for prompt`, {
          provider: "mock",
        });
      }
    }

    // Validate against schema
    const result = options.schema.safeParse(data);
    if (!result.success) {
      throw new AIError("INVALID_REQUEST", `Mock structured data failed schema validation`, {
        provider: "mock",
      });
    }

    return {
      data: result.data,
      rawText: JSON.stringify(data),
      usage: response.usage ?? this.defaultResponse.usage,
    };
  }
}

/**
 * Create a mock provider pre-configured with common test fixtures.
 */
export function createMockProvider(fixtures: Record<string, MockResponse> = {}): MockProvider {
  const provider = new MockProvider();
  for (const [prompt, response] of Object.entries(fixtures)) {
    provider.setResponse(prompt, response);
  }
  return provider;
}