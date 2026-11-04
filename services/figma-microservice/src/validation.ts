// Input validation for job payloads.
//
// Job URLs are navigated by a headless browser on the server and locales are
// used as path segments for artifact files, so both are trust boundaries:
// - only http(s) URLs may be captured (file://, data:, chrome:// etc. would let a
//   job screenshot local files such as /proc/self/environ)
// - locales must be simple BCP47-like tokens so they can never escape RUNS_DIR

const LOCALE_PATTERN = /^[a-z0-9]{1,8}(?:[-_][a-z0-9]{1,8}){0,3}$/i;
const MAX_BREAKPOINT = 8192;

export function isCapturableUrl(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function isSafeLocale(value: unknown): value is string {
  return typeof value === "string" && LOCALE_PATTERN.test(value);
}

export function isValidBreakpoint(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= MAX_BREAKPOINT;
}

export const MAX_BREAKPOINT_WIDTH = MAX_BREAKPOINT;
