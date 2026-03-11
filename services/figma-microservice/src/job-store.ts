import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { CreateJobRequest, ImportJob } from "./types";
import { toPageSelections } from "./selection";
import { createCaptureRunner } from "./capture";
import { getEnvInt, getEnvOr } from "./env";
import { logEvent } from "./logger";

const jobs = new Map<string, ImportJob>();
const jobInputs = new Map<string, CreateJobRequest>();

export function listJobs(): ImportJob[] {
  return [...jobs.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function getJob(jobId: string): ImportJob | undefined {
  return jobs.get(jobId);
}

export function createJob(payload: CreateJobRequest): ImportJob {
  const jobId = randomUUID();
  const now = new Date().toISOString();
  const selections = toPageSelections(
    payload.pages || [],
    payload.locales || [],
    payload.breakpoints || [],
    payload.targets
  );
  const job: ImportJob = {
    id: jobId,
    figmaFileKey: payload.figmaFileKey || "",
    createdAt: now,
    updatedAt: now,
    status: "queued",
    selections,
    warnings: [],
    summary: {
      total: selections.length,
      completed: 0,
      failed: 0
    },
    tasks: [],
    runDir: join(getEnvOr("RUNS_DIR", "runs"), jobId)
  };

  jobs.set(job.id, job);
  jobInputs.set(job.id, payload);
  void runJob(job.id);
  return job;
}

async function runJob(jobId: string): Promise<void> {
  const job = jobs.get(jobId);
  const input = jobInputs.get(jobId);
  if (!job) {
    return;
  }
  if (!input) {
    job.status = "failed";
    job.warnings.push("Missing job input payload.");
    job.updatedAt = new Date().toISOString();
    return;
  }
  const jobRef = job;
  const inputRef = input;

  jobRef.status = "running";
  jobRef.updatedAt = new Date().toISOString();
  logEvent("INFO", "job.started", {
    jobId: jobRef.id,
    totalTasks: jobRef.selections.length
  });

  const runner = await createCaptureRunner(inputRef, jobRef.id);
  const concurrency = Math.max(1, getEnvInt("JOB_CONCURRENCY", 3));
  let nextIndex = 0;

  async function runSingle(selectionIndex: number): Promise<void> {
    const selection = jobRef.selections[selectionIndex];
    const taskStart = Date.now();
    logEvent("INFO", "job.task.started", {
      jobId: jobRef.id,
      index: selectionIndex + 1,
      total: jobRef.summary.total,
      locale: selection.locale,
      breakpoint: selection.breakpoint,
      route: selection.url
    });

    try {
      const captureStart = Date.now();
      const capture = await runner.capture(selection);
      const captureMs = Date.now() - captureStart;
      const figmaMs = 0;
      const result = {
        status: "success" as const,
        message: "Capture stored for plugin import."
      };
      jobRef.tasks.push({
        page: selection.url,
        routeKey: selection.routeKey,
        locale: selection.locale,
        breakpoint: selection.breakpoint,
        status: result.status,
        message: `${result.message} Screenshot: ${capture.width}x${capture.height}`,
        artifactPath: capture.artifactPath
      });

      jobRef.summary.completed += 1;
      const compactMessage = result.message.replaceAll(/\s+/g, " ").slice(0, 240);
      logEvent("INFO", "job.task.completed", {
        jobId: jobRef.id,
        index: selectionIndex + 1,
        total: jobRef.summary.total,
        status: result.status,
        locale: selection.locale,
        breakpoint: selection.breakpoint,
        elapsedMs: Date.now() - taskStart,
        captureMs,
        figmaMs,
        message: compactMessage
      });
    } catch (error) {
      jobRef.summary.failed += 1;
      jobRef.tasks.push({
        page: selection.url,
        routeKey: selection.routeKey,
        locale: selection.locale,
        breakpoint: selection.breakpoint,
        status: "failed",
        message: error instanceof Error ? error.message : "Unknown error"
      });
      const errorMessage =
        error instanceof Error ? error.message.replaceAll(/\s+/g, " ").slice(0, 240) : "Unknown error";
      logEvent("ERROR", "job.task.failed", {
        jobId: jobRef.id,
        index: selectionIndex + 1,
        total: jobRef.summary.total,
        locale: selection.locale,
        breakpoint: selection.breakpoint,
        elapsedMs: Date.now() - taskStart,
        error: errorMessage
      });
    }
    jobRef.updatedAt = new Date().toISOString();
  }

  async function worker(): Promise<void> {
    while (true) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= jobRef.selections.length) {
        return;
      }
      await runSingle(current);
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, jobRef.selections.length) }, () => worker()));
  } finally {
    await runner.close();
  }

  jobRef.status = jobRef.summary.failed > 0 ? "failed" : "success";
  await writeManifest(jobRef);
  jobRef.updatedAt = new Date().toISOString();
  logEvent("INFO", "job.finished", {
    jobId: jobRef.id,
    status: jobRef.status,
    completed: jobRef.summary.completed,
    failed: jobRef.summary.failed
  });
}

async function writeManifest(job: ImportJob): Promise<void> {
  const runsDir = getEnvOr("RUNS_DIR", "runs");
  const manifestPath = join(runsDir, job.id, "manifest.json");
  await mkdir(join(runsDir, job.id), { recursive: true });
  await Bun.write(manifestPath, JSON.stringify(job, null, 2));
}
