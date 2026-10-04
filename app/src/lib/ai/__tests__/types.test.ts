/**
 * Tests for AI Provider Types
 */

import { AIError, AIErrorCode } from "../types";

describe("AIError", () => {
  test("creates error with code and message", () => {
    const err = new AIError("RATE_LIMITED", "Rate limited");
    expect(err.code).toBe("RATE_LIMITED");
    expect(err.message).toBe("Rate limited");
    expect(err.retryable).toBe(false);
  });

  test("creates error with retryable flag", () => {
    const err = new AIError("NETWORK_ERROR", "Network error", { retryable: true });
    expect(err.retryable).toBe(true);
  });

  test("creates error with status code", () => {
    const err = new AIError("AUTH_ERROR", "Unauthorized", { statusCode: 401 });
    expect(err.statusCode).toBe(401);
  });

  test("creates error with provider", () => {
    const err = new AIError("MODEL_ERROR", "Model error", { provider: "anthropic" });
    expect(err.provider).toBe("anthropic");
  });

  test("all error codes are valid", () => {
    const codes: AIErrorCode[] = [
      "RATE_LIMITED",
      "AUTH_ERROR",
      "INVALID_REQUEST",
      "MODEL_ERROR",
      "NETWORK_ERROR",
      "UNKNOWN_ERROR",
    ];
    for (const code of codes) {
      const err = new AIError(code, "test");
      expect(err.code).toBe(code);
    }
  });
});