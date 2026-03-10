import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { FigmaApiClient } from "./figma";
import type { CreateJobRequest, ImportJob } from "./types";
import { toPageSelections } from "./selection";
import { captureSelection } from "./capture";

const jobs = new Map<string, ImportJob>();
const jobInputs = new Map<string, CreateJobRequest>();
const figma = new FigmaApiClient();

export function listJobs(): ImportJob[] {
  return [...jobs.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function getJob(jobId: string): ImportJob | undefined {
  return jobs.get(jobId);
}

export function createJob(payload: CreateJobRequest): ImportJob {
  const jobId = randomUUID();
  const now = new Date().toISOString();
  const selections = toPageSelections(payload.pages, payload.locales, payload.breakpoints);
  const job: ImportJob = {
    id: jobId,
    figmaFileKey: payload.figmaFileKey,
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
    runDir: join(process.env.RUNS_DIR?.trim() || "runs", jobId)
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

  job.status = "running";
  job.updatedAt = new Date().toISOString();

  for (const selection of job.selections) {
    try {
      const capture = await captureSelection(input, job.id, selection);
      const artifactUrl = toArtifactPublicUrl(job.id, capture.artifactPath, input);
      const result = await figma.createOrUpdateFrame({
        fileKey: job.figmaFileKey,
        selection,
        artifactUrl,
        nodeId: input.figmaNodeId
      });
      job.tasks.push({
        page: selection.url,
        locale: selection.locale,
        breakpoint: selection.breakpoint,
        status: result.status,
        message: `${result.message} Screenshot: ${capture.width}x${capture.height}`,
        artifactPath: capture.artifactPath
      });

      if (result.status === "failed") {
        job.summary.failed += 1;
      } else {
        job.summary.completed += 1;
      }
    } catch (error) {
      job.summary.failed += 1;
      job.tasks.push({
        page: selection.url,
        locale: selection.locale,
        breakpoint: selection.breakpoint,
        status: "failed",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
    job.updatedAt = new Date().toISOString();
  }

  job.status = job.summary.failed > 0 ? "failed" : "success";
  if (!process.env.FIGMA_TOKEN) {
    job.warnings.push("FIGMA_TOKEN is not set. Job executed as dry-run.");
  }
  await writeManifest(job);
  job.updatedAt = new Date().toISOString();
}

async function writeManifest(job: ImportJob): Promise<void> {
  const manifestPath = join(process.env.RUNS_DIR?.trim() || "runs", job.id, "manifest.json");
  await mkdir(join(process.env.RUNS_DIR?.trim() || "runs", job.id), { recursive: true });
  await Bun.write(manifestPath, JSON.stringify(job, null, 2));
}

function toArtifactPublicUrl(
  jobId: string,
  artifactPath: string,
  input: CreateJobRequest
): string | undefined {
  const baseUrl = input.artifactPublicBaseUrl || process.env.ARTIFACT_PUBLIC_BASE_URL;
  if (!baseUrl) {
    return undefined;
  }
  const runsDir = (process.env.RUNS_DIR?.trim() || "runs").replace(/\/+$/, "");
  const runsPrefix = `${runsDir}/`;
  const relativePath = artifactPath.startsWith(runsPrefix)
    ? artifactPath.slice(runsPrefix.length)
    : artifactPath;
  const encoded = relativePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${baseUrl.replace(/\/+$/, "")}/api/jobs/${encodeURIComponent(jobId)}/artifacts/${encoded}`;
}
