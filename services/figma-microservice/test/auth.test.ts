import { describe, expect, test } from "bun:test";
import { verifyAdminFromAuthorizationHeader } from "../src/auth";

// Smoke test for the Clerk integration: malformed credentials are rejected locally,
// before any JWKS lookup, so this runs offline.

describe("verifyAdminFromAuthorizationHeader", () => {
  test("rejects missing, non-bearer and malformed tokens", async () => {
    process.env.CLERK_SECRET_KEY = "sk_test_placeholder_for_tests";
    for (const header of [undefined, "", "Basic dXNlcjpwYXNz", "Bearer", "Bearer not-a-jwt", "Bearer a.b.c"]) {
      expect(await verifyAdminFromAuthorizationHeader(header)).toBeNull();
    }
  });

  test("rejects every token when CLERK_SECRET_KEY is unset", async () => {
    delete process.env.CLERK_SECRET_KEY;
    expect(await verifyAdminFromAuthorizationHeader("Bearer a.b.c")).toBeNull();
  });
});
