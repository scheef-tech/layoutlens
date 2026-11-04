import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Route-level tests for POST /api/jobs. Auth is bypassed via DEV_DISABLE_AUTH and the
// Playwright capture runner is mocked, so no browser or Clerk instance is needed.

let runsDir = "";
let app: { fetch: (request: Request) => Response | Promise<Response> };
const capturedUrls: string[] = [];

beforeAll(async () => {
  runsDir = await mkdtemp(join(tmpdir(), "layoutlens-api-"));
  process.env.RUNS_DIR = runsDir;
  process.env.DEV_DISABLE_AUTH = "true";
  process.env.JOB_ACCESS_SECRET = "test-secret";
  mock.module("../src/capture", () => ({
    createCaptureRunner: async () => ({
      capture: async (selection: { url: string; locale: string; breakpoint: number }) => {
        capturedUrls.push(selection.url);
        return { artifactPath: join(runsDir, "x.png"), width: selection.breakpoint, height: 100 };
      },
      close: async () => {}
    })
  }));
  app = (await import("../src/index")).default;
});

afterAll(async () => {
  await rm(runsDir, { recursive: true, force: true });
});

function postJob(body: unknown): Promise<Response> {
  return Promise.resolve(
    app.fetch(
      new Request("http://localhost/api/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      })
    )
  );
}

describe("POST /api/jobs input validation", () => {
  test("rejects file:// targets", async () => {
    const res = await postJob({
      pages: [],
      locales: [],
      targets: [{ url: "file:///proc/self/environ", locale: "de" }],
      breakpoints: [375]
    });
    expect(res.status).toBe(400);
    expect(capturedUrls).not.toContain("file:///proc/self/environ");
  });

  test("rejects file:// pages in pages x locales mode", async () => {
    const res = await postJob({ pages: ["file:///etc/passwd"], locales: ["de"], breakpoints: [375] });
    expect(res.status).toBe(400);
  });

  test("rejects locales that would escape RUNS_DIR", async () => {
    const res = await postJob({
      pages: [],
      locales: [],
      targets: [{ url: "https://example.com/", locale: "../../../tmp/pwn" }],
      breakpoints: [375]
    });
    expect(res.status).toBe(400);
  });

  test("rejects payloads without any valid breakpoint", async () => {
    const res = await postJob({ pages: ["https://example.com/"], locales: ["de"], breakpoints: [0, 375.5, 1e9] });
    expect(res.status).toBe(400);
  });

  test("accepts a valid https target", async () => {
    const res = await postJob({
      pages: [],
      locales: [],
      targets: [{ url: "https://example.com/de/", locale: "DE" }],
      breakpoints: [375, 1440]
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { id: string; accessToken: string; selections: Array<{ locale: string }> };
    expect(json.accessToken.startsWith(`${json.id}.`)).toBe(true);
    expect(json.selections.map((s) => s.locale)).toEqual(["de", "de"]);
  });
});
