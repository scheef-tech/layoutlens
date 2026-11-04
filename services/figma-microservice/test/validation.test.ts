import { describe, expect, test } from "bun:test";
import { isCapturableUrl, isSafeLocale, isValidBreakpoint } from "../src/validation";

describe("isCapturableUrl", () => {
  test("accepts http and https", () => {
    expect(isCapturableUrl("https://example.com/de/page")).toBe(true);
    expect(isCapturableUrl("http://localhost:5173/")).toBe(true);
  });

  test("rejects local and non-web schemes", () => {
    for (const url of [
      "file:///proc/self/environ",
      "file:///etc/passwd",
      "data:text/html,<h1>x</h1>",
      "javascript:alert(1)",
      "chrome://settings",
      "ftp://example.com/x"
    ]) {
      expect(isCapturableUrl(url)).toBe(false);
    }
  });

  test("rejects malformed and non-string input", () => {
    expect(isCapturableUrl("not a url")).toBe(false);
    expect(isCapturableUrl("")).toBe(false);
    expect(isCapturableUrl(undefined)).toBe(false);
    expect(isCapturableUrl(42)).toBe(false);
  });
});

describe("isSafeLocale", () => {
  test("accepts common locale tokens", () => {
    for (const locale of ["de", "en", "en-us", "en_GB", "zh-hant-tw", "es-419", "default"]) {
      expect(isSafeLocale(locale)).toBe(true);
    }
  });

  test("rejects path traversal and separators", () => {
    for (const locale of ["../../etc", "..", "de/../../x", "de\\x", "/abs", "de en", "", "de\u0000"]) {
      expect(isSafeLocale(locale)).toBe(false);
    }
  });
});

describe("isValidBreakpoint", () => {
  test("accepts positive integers up to the max width", () => {
    expect(isValidBreakpoint(375)).toBe(true);
    expect(isValidBreakpoint(8192)).toBe(true);
  });

  test("rejects fractions, zero, negatives, huge and non-numbers", () => {
    for (const value of [0, -1, 375.5, 8193, 1e9, Number.NaN, Number.POSITIVE_INFINITY, "375"]) {
      expect(isValidBreakpoint(value)).toBe(false);
    }
  });
});
