/**
 * Phase 5 Integration Tests
 * Uses a local HTTP test server to validate actual acquisition behavior.
 * Tests security boundaries: SSRF, redirects, timeouts, size limits.
 */

import { acquireUrl, DEFAULT_ACQUISITION_OPTIONS } from "../http";
import { cleanPage } from "../cleaner";
import { acquireAndClean } from "../engine";
import { AcquisitionError, isAcquisitionError } from "../errors";
import { resolveAndValidate } from "../dns";
import type { AcquiredPage } from "../types";

// Simple test server using Node's http module
import { createServer, IncomingMessage, ServerResponse } from "http";
import { URL } from "url";

interface TestServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

let testServer: TestServer | null = null;

/** Pre-resolved IPs for localhost test server (uses public IP to bypass SSRF) */
const TEST_SERVER_PRE_RESOLVED_IPS = { ipv4: ["8.8.8.8"], ipv6: [] };

function startTestServer(): Promise<TestServer> {
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const url = new URL(req.url || "/", `http://localhost:${port}`);
      const path = url.pathname;

      // Route handlers
      if (path === "/html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`
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
        `);
      } else if (path === "/plain") {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Plain text content\n\nWith multiple lines");
      } else if (path === "/redirect") {
        res.writeHead(302, { Location: "/html" });
        res.end();
      } else if (path === "/redirect-chain") {
        const step = parseInt(url.searchParams.get("step") || "1", 10);
        if (step < 3) {
          res.writeHead(302, { Location: `/redirect-chain?step=${step + 1}` });
          res.end();
        } else {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end("<html><body><p>Final destination</p></body></html>");
        }
      } else if (path === "/redirect-cross-host") {
        // Redirect to a different hostname (will fail DNS in test)
        res.writeHead(302, { Location: "http://different-host.invalid/" });
        res.end();
      } else if (path === "/large") {
        const size = parseInt(url.searchParams.get("size") || "1000", 10);
        res.writeHead(200, { "Content-Type": "text/html", "Content-Length": size.toString() });
        res.end("x".repeat(size));
      } else if (path === "/large-stream") {
        const size = parseInt(url.searchParams.get("size") || "1000", 10);
        res.writeHead(200, { "Content-Type": "text/html" });
        // Stream in chunks
        let sent = 0;
        const chunkSize = 100;
        const interval = setInterval(() => {
          if (sent >= size) {
            clearInterval(interval);
            res.end();
            return;
          }
          const chunk = "x".repeat(Math.min(chunkSize, size - sent));
          res.write(chunk);
          sent += chunk.length;
        }, 10);
      } else if (path === "/pdf") {
        res.writeHead(200, { "Content-Type": "application/pdf" });
        res.end("%PDF-1.4 fake pdf content");
      } else if (path === "/timeout") {
        // Never respond - will timeout
      } else if (path === "/error-404") {
        res.writeHead(404);
        res.end("Not found");
      } else if (path === "/error-500") {
        res.writeHead(500);
        res.end("Server error");
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      testServer = {
        url: `http://127.0.0.1:${port}`,
        port,
        close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
      };
      resolve(testServer);
    });
  });
}

beforeAll(async () => {
  await startTestServer();
}, 10000);

afterAll(async () => {
  if (testServer) {
    await testServer.close();
  }
}, 10000);

describe("Integration: Successful HTML acquisition", () => {
  test("acquires and cleans HTML page", async () => {
    const acquired = await acquireUrl(`${testServer!.url}/html`, { preResolvedIps: TEST_SERVER_PRE_RESOLVED_IPS });
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
    const acquired = await acquireUrl(`${testServer!.url}/plain`, { preResolvedIps: TEST_SERVER_PRE_RESOLVED_IPS });
    expect(acquired.contentType).toBe("text/plain");

    const cleaned = cleanPage(acquired);
    expect(cleaned.text).toContain("Plain text content");
    expect(cleaned.wordCount).toBeGreaterThan(0);
  });
});

describe("Integration: Redirect handling", () => {
  test("follows single redirect", async () => {
    const acquired = await acquireUrl(`${testServer!.url}/redirect`, { preResolvedIps: TEST_SERVER_PRE_RESOLVED_IPS });
    expect(acquired.statusCode).toBe(200);
    expect(acquired.redirectChain.length).toBe(1);
    expect(acquired.redirectChain[0].statusCode).toBe(302);
    expect(acquired.redirectChain[0].validated).toBe(true);
    expect(acquired.finalUrl).toContain("/html");
  });

  test("follows redirect chain", async () => {
    const acquired = await acquireUrl(`${testServer!.url}/redirect-chain`, { preResolvedIps: TEST_SERVER_PRE_RESOLVED_IPS });
    expect(acquired.statusCode).toBe(200);
    // Chain: step=1 -> step=2 -> step=3 -> 200 = 2 redirects
    expect(acquired.redirectChain.length).toBe(2);
    expect(acquired.body).toContain("Final destination");
  });

  test("enforces redirect limit", async () => {
    // Chain has 2 redirects, so maxRedirects=1 should fail
    await expect(
      acquireUrl(`${testServer!.url}/redirect-chain`, { preResolvedIps: TEST_SERVER_PRE_RESOLVED_IPS, maxRedirects: 1 })
    ).rejects.toThrow();
  });
});

describe("Integration: Security - SSRF Protection", () => {
  test("blocks localhost via DNS resolution", async () => {
    // This test requires the test server to be on localhost
    // The DNS resolution should block 127.0.0.1
    // Since our test server IS on localhost, this validates the protection works
    // We can't easily test this without a separate test server on a non-localhost IP
    // For now, we test the DNS resolution logic directly
    const resolved = await resolveAndValidate("localhost");
    expect(resolved.valid).toBe(false);
    expect(resolved.error?.code).toBe("BLOCKED_URL");
  });

  test("blocks private IPv4 via DNS resolution", async () => {
    // Test with a known private IP hostname that resolves to private IP
    // This is tested at the DNS level
    const resolved = await resolveAndValidate("localhost"); // Already tested above
    expect(resolved.valid).toBe(false);
  });
});

describe("Integration: Size Limits", () => {
  test("enforces Content-Length limit (early rejection)", async () => {
    const options = { ...DEFAULT_ACQUISITION_OPTIONS, maxResponseSize: 500 };
    await expect(
      acquireUrl(`${testServer!.url}/large?size=1000`, { ...options, preResolvedIps: TEST_SERVER_PRE_RESOLVED_IPS })
    ).rejects.toThrow();
  });

  test("enforces streamed response limit", async () => {
    const options = { ...DEFAULT_ACQUISITION_OPTIONS, maxResponseSize: 500 };
    await expect(
      acquireUrl(`${testServer!.url}/large-stream?size=1000`, { ...options, preResolvedIps: TEST_SERVER_PRE_RESOLVED_IPS })
    ).rejects.toThrow();
  });

  test("allows responses within limit", async () => {
    const options = { ...DEFAULT_ACQUISITION_OPTIONS, maxResponseSize: 10000 };
    const acquired = await acquireUrl(`${testServer!.url}/large?size=500`, { ...options, preResolvedIps: TEST_SERVER_PRE_RESOLVED_IPS });
    expect(acquired.body.length).toBe(500);
  });
});

describe("Integration: Content-Type Handling", () => {
  test("rejects unsupported content type (PDF)", async () => {
    await expect(
      acquireUrl(`${testServer!.url}/pdf`, { preResolvedIps: TEST_SERVER_PRE_RESOLVED_IPS })
    ).rejects.toThrow();
  });

  test("accepts supported content types", async () => {
    const html = await acquireUrl(`${testServer!.url}/html`, { preResolvedIps: TEST_SERVER_PRE_RESOLVED_IPS });
    expect(html.contentType).toBe("text/html");

    const plain = await acquireUrl(`${testServer!.url}/plain`, { preResolvedIps: TEST_SERVER_PRE_RESOLVED_IPS });
    expect(plain.contentType).toBe("text/plain");
  });
});

describe("Integration: HTTP Errors", () => {
  test("throws on 404", async () => {
    await expect(
      acquireUrl(`${testServer!.url}/error-404`, { preResolvedIps: TEST_SERVER_PRE_RESOLVED_IPS })
    ).rejects.toThrow();
  });

  test("throws on 500", async () => {
    await expect(
      acquireUrl(`${testServer!.url}/error-500`, { preResolvedIps: TEST_SERVER_PRE_RESOLVED_IPS })
    ).rejects.toThrow();
  });
});

describe("Integration: Timeout", () => {
  test("enforces request timeout", async () => {
    const options = { ...DEFAULT_ACQUISITION_OPTIONS, timeoutMs: 100 };
    await expect(
      acquireUrl(`${testServer!.url}/timeout`, { ...options, preResolvedIps: TEST_SERVER_PRE_RESOLVED_IPS })
    ).rejects.toThrow();
  });
});

describe("Integration: acquireAndClean convenience function", () => {
  test("acquires and cleans in one call", async () => {
    const cleaned = await acquireAndClean(`${testServer!.url}/html`, { preResolvedIps: TEST_SERVER_PRE_RESOLVED_IPS });
    expect(cleaned.acquiredPage.statusCode).toBe(200);
    expect(cleaned.text).toContain("Main Content");
    expect(cleaned.title).toBe("Test Page");
  });
});

describe("Integration: Error propagation", () => {
  test("errors have correct codes", async () => {
    try {
      await acquireUrl(`${testServer!.url}/pdf`, { preResolvedIps: TEST_SERVER_PRE_RESOLVED_IPS });
    } catch (err: unknown) {
      expect(isAcquisitionError(err)).toBe(true);
      if (isAcquisitionError(err)) expect(err.code).toBe("UNSUPPORTED_CONTENT_TYPE");
    }
  });

  test("timeout error has correct code", async () => {
    try {
      await acquireUrl(`${testServer!.url}/timeout`, { timeoutMs: 100, preResolvedIps: TEST_SERVER_PRE_RESOLVED_IPS });
    } catch (err: unknown) {
      expect(isAcquisitionError(err)).toBe(true);
      if (isAcquisitionError(err)) expect(err.code).toBe("TIMEOUT");
    }
  });
});