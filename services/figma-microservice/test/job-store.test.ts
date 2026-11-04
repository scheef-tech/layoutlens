import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A browser launch failure must end the job in "failed" instead of leaving it "running".

let runsDir = "";
let store: typeof import("../src/job-store");

beforeAll(async () => {
  runsDir = await mkdtemp(join(tmpdir(), "layoutlens-store-"));
  process.env.RUNS_DIR = runsDir;
  mock.module("../src/capture", () => ({
    createCaptureRunner: async () => {
      throw new Error("browserType.launch: Executable doesn't exist");
    }
  }));
  store = await import("../src/job-store");
});

afterAll(async () => {
  await rm(runsDir, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("createJob", () => {
  test("marks the job failed when the capture runner cannot start", async () => {
    const job = store.createJob({ pages: ["https://example.com/"], locales: ["de"], breakpoints: [375] });
    await waitFor(() => store.getJob(job.id)?.status === "failed");
    const stored = store.getJob(job.id)!;
    expect(stored.status).toBe("failed");
    expect(stored.warnings.join(" ")).toContain("Executable doesn't exist");
  });
});
