/**
 * Tests for Phase 5 HTTP Acquisition
 * Tests the parsing and validation logic without actual network calls.
 */

import { parseContentType, isContentTypeAllowed, readBodyWithLimit } from "../http";
import { isAcquisitionError } from "../errors";

describe("parseContentType", () => {
  test("parses basic content type", () => {
    expect(parseContentType("text/html")).toEqual({ mediaType: "text/html", charset: "utf-8" });
    expect(parseContentType("text/plain")).toEqual({ mediaType: "text/plain", charset: "utf-8" });
    expect(parseContentType("application/xhtml+xml")).toEqual({ mediaType: "application/xhtml+xml", charset: "utf-8" });
  });

  test("parses content type with charset", () => {
    expect(parseContentType("text/html; charset=utf-8")).toEqual({ mediaType: "text/html", charset: "utf-8" });
    expect(parseContentType("text/html;charset=iso-8859-1")).toEqual({ mediaType: "text/html", charset: "iso-8859-1" });
    expect(parseContentType('text/html; charset="utf-8"')).toEqual({ mediaType: "text/html", charset: "utf-8" });
  });

  test("handles extra parameters", () => {
    expect(parseContentType("text/html; charset=utf-8; boundary=something")).toEqual({
      mediaType: "text/html",
      charset: "utf-8",
    });
  });

  test("defaults for missing header", () => {
    expect(parseContentType(null)).toEqual({ mediaType: "application/octet-stream", charset: "utf-8" });
    expect(parseContentType("")).toEqual({ mediaType: "application/octet-stream", charset: "utf-8" });
  });
});

describe("isContentTypeAllowed", () => {
  const allowed = ["text/html", "text/plain", "application/xhtml+xml"];

  test("allows exact matches", () => {
    expect(isContentTypeAllowed("text/html", allowed)).toBe(true);
    expect(isContentTypeAllowed("text/plain", allowed)).toBe(true);
    expect(isContentTypeAllowed("application/xhtml+xml", allowed)).toBe(true);
  });

  test("rejects non-allowed types", () => {
    expect(isContentTypeAllowed("application/pdf", allowed)).toBe(false);
    expect(isContentTypeAllowed("image/png", allowed)).toBe(false);
    expect(isContentTypeAllowed("video/mp4", allowed)).toBe(false);
    expect(isContentTypeAllowed("application/json", allowed)).toBe(false);
  });

  test("rejects unknown types", () => {
    expect(isContentTypeAllowed("application/octet-stream", allowed)).toBe(false);
  });
});

describe("readBodyWithLimit", () => {
  test("reads stream within limit", async () => {
    const chunks = [new TextEncoder().encode("hello"), new TextEncoder().encode(" world")];
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });

    const result = await readBodyWithLimit(stream, 100, "utf-8");
    expect(result).toBe("hello world");
  });

  test("enforces size limit mid-stream", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("a".repeat(100)));
        controller.enqueue(new TextEncoder().encode("b".repeat(100)));
        controller.close();
      },
    });

    await expect(readBodyWithLimit(stream, 150, "utf-8")).rejects.toThrow();
  });

  test("handles empty stream", async () => {
    const stream = new ReadableStream({ start(controller) { controller.close(); } });
    const result = await readBodyWithLimit(stream, 100, "utf-8");
    expect(result).toBe("");
  });

  test("handles null body", async () => {
    const result = await readBodyWithLimit(null, 100, "utf-8");
    expect(result).toBe("");
  });

  test("handles exact limit", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("a".repeat(100)));
        controller.close();
      },
    });
    const result = await readBodyWithLimit(stream, 100, "utf-8");
    expect(result.length).toBe(100);
  });
});