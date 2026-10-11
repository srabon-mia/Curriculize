import { vi } from "vitest";

/**
 * Phase 5 Integration Tests
 * Tests the full acquisition pipeline with mocked transport layer.
 * This avoids SSRF protection blocking local test servers while still
 * exercising real URL validation, DNS resolution (mocked), redirect handling,
 * size limits, content-type checks, and timeout/AbortController logic.
 */

// Mock DNS resolution to return valid public IPs for test hostnames
vi.mock("../dns", () => {
  return {
    resolveAndValidate: vi.fn().mockImplementation(async (hostname: string) => {
      const normalized = hostname.toLowerCase().replace(/\.+$/, "");
      // Return valid public IPs for all test hostnames
      return {
        hostname: normalized,
        ipv4: ["8.8.8.8"],
        ipv6: ["2001:4860:4860::8888"],
        valid: true,
      };
    }),
    normalizeHostname: vi.fn().mockImplementation((hostname: string) => hostname.toLowerCase().replace(/\.+$/, "")),
    selectConnectionIp: vi.fn().mockImplementation((resolved: any) => resolved.ipv6[0] || resolved.ipv4[0]),
    canReuseResolution: vi.fn().mockImplementation((current: string, redirect: string) => current === redirect),
  };
});

// Mock undici request at the transport layer
// Each test configures the mock to return appropriate responses
vi.mock("undici", () => {
  let mockImpl: (url: string, options: any) => Promise<any> = async () => {
    throw new Error("undici mock not configured");
  };

  // Mock Agent class that can be instantiated
  class MockAgent {
    close = vi.fn().mockResolvedValue(undefined);
  }

  return {
    request: vi.fn().mockImplementation((url, options) => mockImpl(url, options)),
    Agent: MockAgent,
    setMockImplementation: (impl: typeof mockImpl) => { mockImpl = impl; },
  };
});

import { acquireUrl, DEFAULT_ACQUISITION_OPTIONS } from "../http";
import { cleanPage } from "../cleaner";
import { acquireAndClean } from "../engine";
import { AcquisitionError, isAcquisitionError } from "../errors";
import type { AcquiredPage } from "../types";

// Get the mock setter
const { setMockImplementation } = await vi.importMock<{ setMockImplementation: (impl: any) => void }>("undici");

/** Helper to create a mock response */
function createMockResponse(overrides: {
  statusCode?: number;
  headers?: Record<string, string>;
  body?: string;
  bodyBytes?: Uint8Array;
} = {}) {
  const statusCode = overrides.statusCode ?? 200;
  const headers = {
    "content-type": "text/html; charset=utf-8",
    ...overrides.headers,
  };
  const bodyStr = overrides.body ?? "<html><body><p>Test content</p></body></html>";
  const bodyBytes = overrides.bodyBytes ?? new TextEncoder().encode(bodyStr);

  return {
    statusCode,
    headers,
    body: {
      bytes: vi.fn().mockResolvedValue(bodyBytes),
    },
  };
}

/** Helper to create a hanging response for timeout test */
function createHangingResponse(signal: AbortSignal) {
  return new Promise((_resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const handleAbort = () => {
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", handleAbort, { once: true });
  });
}

beforeEach(() => {
  // Reset to default throwing implementation
  setMockImplementation(async () => {
    throw new Error("undici mock not configured for this test");
  });
});

describe("Integration: Successful HTML acquisition", () => {
  test("acquires and cleans HTML page", async () => {
    setMockImplementation(async () => createMockResponse({
      statusCode: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: `
        <html>
          <head><title>Test Page</title><meta name="description" content="Test description"></head>
          <body>
            <nav>Navigation</nav>
            <main><h1>Main Content</h1><p>This is the main content.</p></main>
            <footer>Footer</footer>
            <script>console.log('removed')</script>
            <style>body { color: red; }</style>
          </body>
        </html>
      `,
    }));

    const acquired = await acquireUrl("http://example.com/html");
    expect(acquired.statusCode).toBe(200);
    expect(acquired.contentType).toBe("text/html");
    expect(acquired.body).toContain("Main Content");

    const cleaned = cleanPage(acquired);
    expect(cleaned.title).toBe("Test Page");
    expect(cleaned.description).toBe("Test description");
    expect(cleaned.text).toContain("Main Content");
    expect(cleaned.text).not.toContain("Navigation");
    expect(cleaned.text).not.toContain("Footer");
    expect(cleaned.text).not.toContain("removed");
    expect(cleaned.wordCount).toBeGreaterThan(0);
  });
});

describe("Integration: Plain text acquisition", () => {
  test("acquires and cleans plain text", async () => {
    setMockImplementation(async () => createMockResponse({
      statusCode: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: "Plain text content\n\nWith multiple lines",
    }));

    const acquired = await acquireUrl("http://example.com/plain");
    expect(acquired.contentType).toBe("text/plain");

    const cleaned = cleanPage(acquired);
    expect(cleaned.text).toContain("Plain text content");
    expect(cleaned.wordCount).toBeGreaterThan(0);
  });
});

describe("Integration: Redirect handling", () => {
  test("follows single redirect", async () => {
    let redirectCount = 0;
    setMockImplementation(async (url: string) => {
      if (url.includes("/redirect") && !url.includes("/html")) {
        redirectCount++;
        return createMockResponse({
          statusCode: 302,
          headers: { "content-type": "text/html", location: "/html" },
          body: "",
        });
      }
      // Final destination
      redirectCount++;
      return createMockResponse({
        statusCode: 200,
        headers: { "content-type": "text/html" },
        body: "<html><body><p>Main Content</p></body></html>",
      });
    });

    const acquired = await acquireUrl("http://example.com/redirect");
    expect(acquired.statusCode).toBe(200);
    expect(acquired.redirectChain.length).toBe(1);
    expect(acquired.redirectChain[0].statusCode).toBe(302);
    expect(acquired.redirectChain[0].validated).toBe(true);
    expect(acquired.finalUrl).toContain("/html");
  });

  test("follows redirect chain", async () => {
    let step = 1;
    setMockImplementation(async (url: string) => {
      if (url.includes("step=")) {
        const currentStep = parseInt(url.split("step=")[1], 10);
        if (currentStep < 3) {
          step++;
          return createMockResponse({
            statusCode: 302,
            headers: { "content-type": "text/html", location: `/redirect-chain?step=${currentStep + 1}` },
            body: "",
          });
        }
      }
      // Final destination
      return createMockResponse({
        statusCode: 200,
        headers: { "content-type": "text/html" },
        body: "<html><body><p>Final destination</p></body></html>",
      });
    });

    const acquired = await acquireUrl("http://example.com/redirect-chain?step=1");
    expect(acquired.statusCode).toBe(200);
    expect(acquired.redirectChain.length).toBe(2);
    expect(acquired.body).toContain("Final destination");
  });

  test("enforces redirect limit", async () => {
    let step = 1;
    setMockImplementation(async (url: string) => {
      if (url.includes("step=")) {
        const currentStep = parseInt(url.split("step=")[1], 10);
        if (currentStep < 3) {
          step++;
          return createMockResponse({
            statusCode: 302,
            headers: { "content-type": "text/html", location: `/redirect-chain?step=${currentStep + 1}` },
            body: "",
          });
        }
      }
      return createMockResponse({
        statusCode: 200,
        headers: { "content-type": "text/html" },
        body: "<html><body><p>Final destination</p></body></html>",
      });
    });

    await expect(
      acquireUrl("http://example.com/redirect-chain?step=1", { maxRedirects: 1 })
    ).rejects.toThrow();
  });
});

describe("Integration: Size Limits", () => {
  test("enforces Content-Length limit (early rejection)", async () => {
    const largeBody = "x".repeat(1000);
    setMockImplementation(async () => createMockResponse({
      statusCode: 200,
      headers: { "content-type": "text/html", "content-length": "1000" },
      body: largeBody,
    }));

    const options = { ...DEFAULT_ACQUISITION_OPTIONS, maxResponseSize: 500 };
    await expect(
      acquireUrl("http://example.com/large?size=1000", options)
    ).rejects.toThrow();
  });

  test("enforces streamed response limit", async () => {
    const largeBody = "x".repeat(1000);
    setMockImplementation(async () => createMockResponse({
      statusCode: 200,
      headers: { "content-type": "text/html" },
      body: largeBody,
    }));

    const options = { ...DEFAULT_ACQUISITION_OPTIONS, maxResponseSize: 500 };
    await expect(
      acquireUrl("http://example.com/large-stream?size=1000", options)
    ).rejects.toThrow();
  });

  test("allows responses within limit", async () => {
    const body = "x".repeat(500);
    setMockImplementation(async () => createMockResponse({
      statusCode: 200,
      headers: { "content-type": "text/html" },
      body,
    }));

    const options = { ...DEFAULT_ACQUISITION_OPTIONS, maxResponseSize: 10000 };
    const acquired = await acquireUrl("http://example.com/large?size=500", options);
    expect(acquired.body.length).toBe(500);
  });
});

describe("Integration: Content-Type Handling", () => {
  test("rejects unsupported content type (PDF)", async () => {
    setMockImplementation(async () => createMockResponse({
      statusCode: 200,
      headers: { "content-type": "application/pdf" },
      body: "%PDF-1.4 fake pdf content",
    }));

    await expect(
      acquireUrl("http://example.com/pdf")
    ).rejects.toThrow();
  });

  test("accepts supported content types", async () => {
    setMockImplementation(async () => createMockResponse({
      statusCode: 200,
      headers: { "content-type": "text/html" },
      body: "<html><body><p>HTML content</p></body></html>",
    }));

    const html = await acquireUrl("http://example.com/html");
    expect(html.contentType).toBe("text/html");

    setMockImplementation(async () => createMockResponse({
      statusCode: 200,
      headers: { "content-type": "text/plain" },
      body: "Plain text content",
    }));

    const plain = await acquireUrl("http://example.com/plain");
    expect(plain.contentType).toBe("text/plain");
  });
});

describe("Integration: HTTP Errors", () => {
  test("throws on 404", async () => {
    setMockImplementation(async () => createMockResponse({
      statusCode: 404,
      headers: { "content-type": "text/plain" },
      body: "Not found",
    }));

    await expect(
      acquireUrl("http://example.com/error-404")
    ).rejects.toThrow();
  });

  test("throws on 500", async () => {
    setMockImplementation(async () => createMockResponse({
      statusCode: 500,
      headers: { "content-type": "text/plain" },
      body: "Server error",
    }));

    await expect(
      acquireUrl("http://example.com/error-500")
    ).rejects.toThrow();
  });
});

describe("Integration: Timeout", () => {
  test("enforces request timeout", async () => {
    // Mock that hangs until abort
    setMockImplementation(async (_url: string, options: any) => {
      const signal = options?.signal;
      return createHangingResponse(signal);
    });

    const options = { ...DEFAULT_ACQUISITION_OPTIONS, timeoutMs: 100 };
    await expect(
      acquireUrl("http://example.com/timeout", options)
    ).rejects.toThrow();
  });
});

describe("Integration: acquireAndClean convenience function", () => {
  test("acquires and cleans in one call", async () => {
    setMockImplementation(async () => createMockResponse({
      statusCode: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: `
        <html>
          <head><title>Test Page</title><meta name="description" content="Test description"></head>
          <body>
            <nav>Navigation</nav>
            <main><h1>Main Content</h1><p>This is the main content.</p></main>
            <footer>Footer</footer>
          </body>
        </html>
      `,
    }));

    const cleaned = await acquireAndClean("http://example.com/html");
    expect(cleaned.acquiredPage.statusCode).toBe(200);
    expect(cleaned.text).toContain("Main Content");
    expect(cleaned.title).toBe("Test Page");
  });
});

describe("Integration: Error propagation", () => {
  test("errors have correct codes", async () => {
    setMockImplementation(async () => createMockResponse({
      statusCode: 200,
      headers: { "content-type": "application/pdf" },
      body: "%PDF-1.4 fake pdf content",
    }));

    try {
      await acquireUrl("http://example.com/pdf");
    } catch (err: unknown) {
      expect(isAcquisitionError(err)).toBe(true);
      if (isAcquisitionError(err)) expect(err.code).toBe("UNSUPPORTED_CONTENT_TYPE");
    }
  });

  test("timeout error has correct code", async () => {
    setMockImplementation(async (_url: string, options: any) => {
      const signal = options?.signal;
      return createHangingResponse(signal);
    });

    try {
      await acquireUrl("http://example.com/timeout", { timeoutMs: 100 });
    } catch (err: unknown) {
      expect(isAcquisitionError(err)).toBe(true);
      if (isAcquisitionError(err)) expect(err.code).toBe("TIMEOUT");
    }
  });
});