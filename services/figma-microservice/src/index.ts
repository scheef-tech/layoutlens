import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { stat } from "node:fs/promises";
import { join, normalize, resolve } from "node:path";
import sharp from "sharp";
import { createJob, getJob, listJobs, startJobCleanup } from "./job-store";
import { FigmaApiClient } from "./figma";
import { discoverLocalesFromUrls, discoverSitemaps } from "./sitemap";
import type { CreateJobRequest, DiscoverSitemapRequest } from "./types";
import { getEnv, getEnvOr } from "./env";
import { verifyAdminFromAuthorizationHeader } from "./auth";
import { createJobAccessToken, parseJobReference } from "./job-access";

const app = new Hono();
const figmaApi = new FigmaApiClient();
startJobCleanup();

app.use("*", cors());

app.get("/health", (c) =>
  c.json({
    ok: true,
    service: "layoutlens-figma-microservice",
    now: new Date().toISOString()
  })
);

async function requireAdmin(c: Context) {
  const auth = await verifyAdminFromAuthorizationHeader(c.req.header("authorization"));
  if (!auth) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  return null;
}

function withAccessToken<T extends { id: string }>(job: T): T & { accessToken: string } {
  return {
    ...job,
    accessToken: createJobAccessToken(job.id)
  };
}

app.post("/api/sitemap/discover", async (c) => {
  const unauthorized = await requireAdmin(c);
  if (unauthorized) {
    return unauthorized;
  }
  const payload = await c.req.json<DiscoverSitemapRequest>().catch(() => null);
  if (!payload?.baseUrl) {
    return c.json({ error: "baseUrl is required" }, 400);
  }

  const fallbackDefaultLocale = getEnv("SITEMAP_DEFAULT_LOCALE");
  const discovered = await discoverSitemaps(
    payload.baseUrl,
    payload.maxUrls ?? 500,
    payload.maxSitemaps ?? 20,
    { defaultLocale: fallbackDefaultLocale }
  );
  const urlDerivedLocales = discoverLocalesFromUrls(discovered.pageUrls, {
    defaultLocale: fallbackDefaultLocale
  });
  const discoveredLocales = [...new Set([...discovered.hreflangs, ...urlDerivedLocales])];

  return c.json({
    sourceSitemaps: discovered.sourceSitemaps,
    pageUrls: discovered.pageUrls,
    discoveredLocales,
    routeGroups: discovered.routeGroups
  });
});

app.post("/api/jobs", async (c) => {
  const unauthorized = await requireAdmin(c);
  if (unauthorized) {
    return unauthorized;
  }
  const payload = await c.req.json<CreateJobRequest>().catch(() => null);
  if (!payload) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const hasTargets = Array.isArray(payload.targets) && payload.targets.length > 0;
  if (!hasTargets && (!Array.isArray(payload.pages) || payload.pages.length === 0)) {
    return c.json({ error: "pages must contain at least one URL (or provide targets)." }, 400);
  }
  if (!hasTargets && (!Array.isArray(payload.locales) || payload.locales.length === 0)) {
    return c.json({ error: "locales must contain at least one locale (or provide targets)." }, 400);
  }
  if (!Array.isArray(payload.breakpoints) || payload.breakpoints.length === 0) {
    return c.json({ error: "breakpoints must contain at least one value" }, 400);
  }

  const cleanBreakpoints = payload.breakpoints
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  const rawTargets = Array.isArray(payload.targets) ? payload.targets : [];
  const cleanTargets = hasTargets
    ? rawTargets
        .filter((target) => target && typeof target.url === "string" && typeof target.locale === "string")
        .map((target) => ({
          url: target.url,
          locale: target.locale.toLowerCase(),
          routeKey: target.routeKey
        }))
    : undefined;

  if (cleanBreakpoints.length === 0) {
    return c.json({ error: "No valid breakpoints provided" }, 400);
  }
  if (hasTargets && (!cleanTargets || cleanTargets.length === 0)) {
    return c.json({ error: "targets must include at least one {url, locale} entry" }, 400);
  }

  const job = createJob({
    ...payload,
    targets: cleanTargets,
    breakpoints: cleanBreakpoints
  });
  return c.json(withAccessToken(job), 201);
});

app.get("/api/figma/projects", async (c) => {
  const unauthorized = await requireAdmin(c);
  if (unauthorized) {
    return unauthorized;
  }
  const teamId = c.req.query("teamId")?.trim() || getEnv("FIGMA_TEAM_ID");
  if (!teamId) {
    return c.json({ error: "teamId is required (or set FIGMA_TEAM_ID)." }, 400);
  }
  try {
    const projects = await figmaApi.listTeamProjects(teamId);
    return c.json({ teamId, projects });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Failed to load projects." }, 502);
  }
});

app.get("/api/figma/projects/:projectId/files", async (c) => {
  const unauthorized = await requireAdmin(c);
  if (unauthorized) {
    return unauthorized;
  }
  const projectId = c.req.param("projectId");
  if (!projectId) {
    return c.json({ error: "projectId is required." }, 400);
  }
  try {
    const files = await figmaApi.listProjectFiles(projectId);
    return c.json({ projectId, files });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Failed to load files." }, 502);
  }
});

app.get("/api/jobs", async (c) => {
  const unauthorized = await requireAdmin(c);
  if (unauthorized) {
    return unauthorized;
  }
  return c.json({
    jobs: listJobs().map((job) => withAccessToken(job))
  });
});

app.get("/api/jobs/:jobId", async (c) => {
  const jobReference = c.req.param("jobId");
  const parsed = parseJobReference(jobReference);
  if (!parsed) {
    return c.json({ error: "Invalid job id signature" }, 401);
  }
  if (!parsed.usesSignature) {
    const unauthorized = await requireAdmin(c);
    if (unauthorized) {
      return unauthorized;
    }
  }

  const job = getJob(parsed.jobId);
  if (!job) {
    return c.json({ error: "Job not found" }, 404);
  }
  return c.json(withAccessToken(job));
});

app.get("/api/jobs/:jobId/artifacts", async (c) => {
  const jobReference = c.req.param("jobId");
  const parsed = parseJobReference(jobReference);
  if (!parsed) {
    return c.json({ error: "Invalid job id signature" }, 401);
  }
  if (!parsed.usesSignature) {
    const unauthorized = await requireAdmin(c);
    if (unauthorized) {
      return unauthorized;
    }
  }

  const job = getJob(parsed.jobId);
  if (!job) {
    return c.json({ error: "Job not found" }, 404);
  }
  const artifacts = job.tasks
    .filter((task) => task.artifactPath)
    .map((task) => ({
      page: task.page,
      locale: task.locale,
      breakpoint: task.breakpoint,
      path: task.artifactPath
    }));
  return c.json({
    artifacts,
    accessToken: createJobAccessToken(job.id)
  });
});

app.get("/api/jobs/:jobId/artifacts/*", async (c) => {
  const jobReference = c.req.param("jobId");
  const parsed = parseJobReference(jobReference);
  if (!parsed) {
    return c.json({ error: "Invalid job id signature" }, 401);
  }
  if (!parsed.usesSignature) {
    const unauthorized = await requireAdmin(c);
    if (unauthorized) {
      return unauthorized;
    }
  }

  const job = getJob(parsed.jobId);
  if (!job) {
    return c.json({ error: "Job not found" }, 404);
  }

  const relativePath = c.req.path.replace(`/api/jobs/${jobReference}/artifacts/`, "");
  const normalizedRelativePath = normalize(relativePath);
  if (!normalizedRelativePath.startsWith(`${parsed.jobId}/`)) {
    return c.json({ error: "Artifact path does not belong to job" }, 403);
  }
  const runsRoot = resolve(getEnvOr("RUNS_DIR", "runs"));
  const targetPath = resolve(join(runsRoot, normalizedRelativePath));
  if (!targetPath.startsWith(runsRoot)) {
    return c.json({ error: "Invalid artifact path" }, 400);
  }
  try {
    const info = await stat(targetPath);
    if (!info.isFile()) {
      return c.json({ error: "Artifact not found" }, 404);
    }
  } catch {
    return c.json({ error: "Artifact not found" }, 404);
  }

  const image = sharp(targetPath, { failOn: "none" });
  const imageMeta = await image.metadata().catch(() => null);
  const width = imageMeta?.width ?? 0;
  const height = imageMeta?.height ?? 0;
  if (c.req.query("meta") === "1") {
    if (width <= 0 || height <= 0) {
      return c.json({ error: "Unsupported image metadata" }, 422);
    }
    return c.json({ width, height });
  }

  const sliceTopRaw = c.req.query("sliceTop");
  const sliceHeightRaw = c.req.query("sliceHeight");
  if (sliceTopRaw || sliceHeightRaw) {
    if (width <= 0 || height <= 0) {
      return c.json({ error: "Unsupported image for slicing" }, 422);
    }
    const parsedTop = Number.parseInt(sliceTopRaw || "0", 10);
    const parsedHeight = Number.parseInt(sliceHeightRaw || "0", 10);
    if (!Number.isFinite(parsedTop) || !Number.isFinite(parsedHeight) || parsedTop < 0 || parsedHeight <= 0) {
      return c.json({ error: "Invalid sliceTop/sliceHeight query values" }, 400);
    }
    const top = Math.min(parsedTop, Math.max(0, height - 1));
    const extractHeight = Math.min(parsedHeight, height - top);
    const slicedBuffer = await sharp(targetPath)
      .extract({
        left: 0,
        top,
        width,
        height: extractHeight
      })
      .png()
      .toBuffer();
    return new Response(new Uint8Array(slicedBuffer), {
      headers: {
        "Content-Type": "image/png"
      }
    });
  }

  return new Response(Bun.file(targetPath), {
    headers: {
      "Content-Type": "image/png"
    }
  });
});

app.get("/dev", (c) => c.html(renderDevUi()));

const port = Number(getEnvOr("PORT", "8787"));
console.log(`layoutlens-figma-microservice listening on http://localhost:${port}`);

export default {
  port,
  fetch: app.fetch
};

function renderDevUi(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>LayoutLens Microservice</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0e1116;
        --bg-soft: #151a22;
        --border: #2d3644;
        --text: #e9eef8;
        --muted: #9facc1;
        --accent: #76a8ff;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        padding: 24px;
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif;
        color: var(--text);
        background: var(--bg);
      }
      h1 { margin-top: 0; font-size: 22px; }
      .grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); }
      .card {
        border: 1px solid var(--border);
        background: var(--bg-soft);
        border-radius: 12px;
        padding: 16px;
      }
      label { display: block; font-size: 13px; color: var(--muted); margin: 10px 0 6px; }
      input, textarea, button, select {
        width: 100%;
        border-radius: 8px;
        border: 1px solid var(--border);
        background: #0b0f15;
        color: var(--text);
        padding: 10px;
      }
      textarea { min-height: 100px; resize: vertical; }
      button {
        cursor: pointer;
        background: #1d2a3e;
        border-color: #314561;
      }
      button:hover { background: #253550; }
      .btn-secondary {
        background: #121925;
      }
      .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
      .row { display: grid; gap: 8px; grid-template-columns: 1fr 1fr; }
      .pages {
        max-height: 220px;
        overflow: auto;
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 8px;
        background: #0b0f15;
      }
      .pages label {
        margin: 0;
        display: flex;
        align-items: center;
        gap: 8px;
        color: var(--text);
      }
      .pages details {
        border-bottom: 1px solid #1b2331;
        padding: 6px 0;
      }
      .pages summary {
        cursor: pointer;
        color: var(--muted);
        font-size: 12px;
        user-select: none;
      }
      .route-option {
        margin-top: 6px;
        display: flex;
        align-items: center;
        gap: 8px;
        color: var(--text);
      }
      .route-option .route-path {
        font-size: 13px;
      }
      .route-option .route-locale {
        font-size: 11px;
        color: var(--muted);
      }
      .artifacts {
        margin-top: 16px;
        display: grid;
        gap: 10px;
        grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
      }
      .artifact-filters {
        margin-top: 8px;
        display: grid;
        gap: 8px;
        grid-template-columns: 1fr 1fr;
      }
      .artifact-item {
        border: 1px solid var(--border);
        border-radius: 8px;
        background: #0b0f15;
        overflow: hidden;
      }
      .help {
        margin-top: 6px;
        color: var(--muted);
        font-size: 12px;
        line-height: 1.35;
      }
      .auth-state {
        margin: 0 0 12px 0;
        padding: 10px 12px;
        border-radius: 8px;
        border: 1px solid var(--border);
        background: #121925;
        color: var(--muted);
        font-size: 12px;
      }
      .auth-state.unlocked {
        display: none;
      }
      .readonly-grid {
        margin-top: 8px;
        display: grid;
        gap: 8px;
      }
      .readonly-item {
        border: 1px solid var(--border);
        border-radius: 8px;
        background: #0b0f15;
        padding: 10px;
      }
      .readonly-item .k {
        color: var(--muted);
        font-size: 12px;
        margin-bottom: 4px;
      }
      .readonly-item .v {
        color: var(--text);
        font-size: 13px;
        word-break: break-word;
      }
      .inline-actions {
        margin-top: 8px;
        display: grid;
        gap: 8px;
        grid-template-columns: 1fr 1fr;
      }
      .job-monitor {
        margin-top: 10px;
        border: 1px solid var(--border);
        border-radius: 8px;
        background: #0b0f15;
        padding: 10px;
      }
      .job-monitor .row-line {
        display: flex;
        justify-content: space-between;
        gap: 8px;
        color: var(--muted);
        font-size: 12px;
        margin-bottom: 6px;
      }
      .progress {
        width: 100%;
        height: 10px;
        background: #111826;
        border: 1px solid var(--border);
        border-radius: 999px;
        overflow: hidden;
      }
      .progress > div {
        height: 100%;
        width: 0%;
        background: linear-gradient(90deg, #2f7cff 0%, #58a2ff 100%);
        transition: width 200ms ease;
      }
      .post-job {
        margin-top: 10px;
        border: 1px solid var(--border);
        border-radius: 8px;
        background: #0b0f15;
        padding: 10px;
      }
      .post-job.hidden {
        display: none;
      }
      .figma-options {
        display: none;
      }
      .post-job h3 {
        margin: 0 0 8px 0;
        font-size: 14px;
      }
      .post-job ol {
        margin: 8px 0 0 18px;
        color: var(--muted);
        font-size: 12px;
      }
      .artifact-item img {
        width: 100%;
        height: 120px;
        object-fit: cover;
        display: block;
      }
      .artifact-meta {
        padding: 8px;
        font-size: 12px;
        color: var(--muted);
      }
      pre {
        margin: 0;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
    </style>
  </head>
  <body>
    <h1>LayoutLens Microservice Dev UI</h1>
    <div id="authState" class="auth-state">Locked: waiting for Clerk token from embedded client-portal.</div>
    <div class="grid">
      <section class="card">
        <h2>Sitemap Discovery</h2>
        <label>Base URL</label>
        <input id="baseUrl" value="https://example.com" />
        <div class="row">
          <div>
            <label>Max URLs</label>
            <input id="maxUrls" value="200" />
          </div>
          <div>
            <label>Max Sitemaps</label>
            <input id="maxSitemaps" value="10" />
          </div>
        </div>
        <button id="discoverBtn">Discover sitemap pages</button>
        <label>Discovered locales</label>
        <input id="locales" placeholder="en,de,fr" />
        <label>Page selection</label>
        <div class="artifact-filters">
          <select id="pageLocaleFilter">
            <option value="">All locales</option>
          </select>
          <div></div>
        </div>
        <div class="inline-actions">
          <button id="selectAllPagesBtn" type="button" class="btn-secondary">Select all</button>
          <button id="selectNoPagesBtn" type="button" class="btn-secondary">Select none</button>
        </div>
        <div id="pages" class="pages"></div>
      </section>

      <section class="card">
        <h2>Job Creation</h2>
        <details class="figma-options">
          <summary>Figma options (hidden for now)</summary>
          <label>Figma team id</label>
          <input id="figmaTeamId" value="${escapeHtml(getEnv("FIGMA_TEAM_ID") || "")}" placeholder="123456789..." />
          <button id="loadProjectsBtn" class="btn-secondary">Load projects</button>
          <div class="inline-actions">
            <button id="openTeamInFigmaBtn" type="button" class="btn-secondary">Create project in Figma</button>
            <button id="reloadProjectsBtn" type="button" class="btn-secondary">Reload projects</button>
          </div>
          <label>Project (folder)</label>
          <select id="figmaProjectSelect">
            <option value="">Select project</option>
          </select>
          <div class="inline-actions">
            <button id="openProjectInFigmaBtn" type="button" class="btn-secondary">Create file in Figma</button>
            <button id="reloadFilesBtn" type="button" class="btn-secondary">Reload files</button>
          </div>
          <label>File</label>
          <select id="figmaFileSelect">
            <option value="">Select file</option>
          </select>
          <div class="readonly-grid">
            <div class="readonly-item">
              <div class="k">Figma write integration</div>
              <div class="v">${escapeHtml(getDevUiConfig().figmaWriteState)}</div>
            </div>
            <div class="readonly-item">
              <div class="k">Import path</div>
              <div class="v">${escapeHtml(getDevUiConfig().importFlow)}</div>
            </div>
          </div>
          <div class="help">Create project/file via the Figma web page buttons above, then reload here and continue.</div>
        </details>
        <label>Breakpoints (comma-separated)</label>
        <input id="breakpoints" value="375,768,1440" />
        <button id="createJobBtn">Create import job</button>
        <div id="jobMonitor" class="job-monitor">
          <div class="row-line"><span>Job</span><span id="jobIdLabel">-</span></div>
          <div class="row-line"><span>Status</span><span id="jobStatusLabel">idle</span></div>
          <div class="row-line"><span>Progress</span><span id="jobProgressLabel">0 / 0</span></div>
          <div class="progress"><div id="jobProgressBar"></div></div>
          <div class="row-line"><span>Latest task</span><span id="jobLatestTask">-</span></div>
        </div>
        <div id="postJobActions" class="post-job hidden">
          <h3>Job complete: next steps</h3>
          <div class="row-line"><span>Signed Job ID</span><span id="postJobId" class="mono">-</span></div>
          <div class="inline-actions">
            <button id="copyJobIdBtn" type="button" class="btn-secondary">Copy signed job id</button>
          </div>
          <ol>
            <li>Run the <span class="mono">Plugins/layoutlens Importer</span> plugin in your target Figma file.</li>
            <li>Set plugin base URL to <span id="postJobBaseUrl" class="mono">-</span>.</li>
            <li>Paste signed job id in plugin UI: <span id="postJobIdInline" class="mono">-</span>.</li>
          </ol>
        </div>
        <label>Last response</label>
        <pre id="output" class="mono"></pre>
        <label>Artifacts</label>
        <div class="artifact-filters">
          <select id="artifactLocaleFilter">
            <option value="">All locales</option>
          </select>
          <select id="artifactBreakpointFilter">
            <option value="">All breakpoints</option>
          </select>
        </div>
        <div id="artifacts" class="artifacts"></div>
      </section>
    </div>

    <script>
      const pagesEl = document.getElementById("pages");
      const outputEl = document.getElementById("output");
      const artifactsEl = document.getElementById("artifacts");
      const pageLocaleFilterEl = document.getElementById("pageLocaleFilter");
      const jobIdLabelEl = document.getElementById("jobIdLabel");
      const jobStatusLabelEl = document.getElementById("jobStatusLabel");
      const jobProgressLabelEl = document.getElementById("jobProgressLabel");
      const jobProgressBarEl = document.getElementById("jobProgressBar");
      const jobLatestTaskEl = document.getElementById("jobLatestTask");
      const postJobActionsEl = document.getElementById("postJobActions");
      const postJobIdEl = document.getElementById("postJobId");
      const postJobBaseUrlEl = document.getElementById("postJobBaseUrl");
      const postJobIdInlineEl = document.getElementById("postJobIdInline");
      const figmaTeamIdEl = document.getElementById("figmaTeamId");
      const figmaProjectSelectEl = document.getElementById("figmaProjectSelect");
      const figmaFileSelectEl = document.getElementById("figmaFileSelect");
      const artifactLocaleFilterEl = document.getElementById("artifactLocaleFilter");
      const artifactBreakpointFilterEl = document.getElementById("artifactBreakpointFilter");
      const authStateEl = document.getElementById("authState");
      let allArtifacts = [];
      let activeJobId = "";
      let activePollToken = 0;
      let embedAuthToken = "";
      let uiUnlocked = false;
      let discoveredLocales = [];
      let discoveredRouteGroups = [];
      const selectedRouteIds = new Set();

      function apiFetch(input, init) {
        const headers = new Headers(init?.headers);
        if (embedAuthToken) {
          headers.set("Authorization", "Bearer " + embedAuthToken);
        }
        return fetch(input, {
          ...init,
          headers
        }).then((response) => {
          if (response.status === 401) {
            setOutput({
              error:
                "Unauthorized. Open /dev inside client-portal so Clerk token handshake can authorize requests."
            });
          }
          return response;
        });
      }

      function setUiLocked(locked) {
        const controls = document.querySelectorAll("input, select, textarea, button");
        for (const control of controls) {
          control.disabled = locked;
        }
        if (locked) {
          authStateEl.textContent =
            "Locked: waiting for Clerk token from embedded client-portal.";
          authStateEl.classList.remove("unlocked");
          return;
        }
        authStateEl.classList.add("unlocked");
      }

      if (window.parent !== window) {
        window.parent.postMessage({ type: "READY" }, "*");
      } else {
        setUiLocked(true);
        setOutput({
          error:
            "This UI is locked when opened directly. Open it inside client-portal (/layoutlens) to authorize."
        });
      }
      window.addEventListener("message", (event) => {
        const data = event.data || {};
        if (data.type !== "AUTH") {
          return;
        }
        embedAuthToken = typeof data.token === "string" ? data.token : "";
        const shouldUnlock = embedAuthToken.length > 0;
        if (shouldUnlock !== uiUnlocked) {
          uiUnlocked = shouldUnlock;
          setUiLocked(!uiUnlocked);
        }
      });
      setUiLocked(true);

      function setOutput(value) {
        outputEl.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      }

      function setJobMonitorState(job) {
        if (!job) {
          jobIdLabelEl.textContent = "-";
          jobStatusLabelEl.textContent = "idle";
          jobProgressLabelEl.textContent = "0 / 0";
          jobProgressBarEl.style.width = "0%";
          jobLatestTaskEl.textContent = "-";
          return;
        }
        const done = (job.summary?.completed || 0) + (job.summary?.failed || 0);
        const total = job.summary?.total || 0;
        const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
        const latest = (job.tasks || [])[job.tasks.length - 1];
        jobIdLabelEl.textContent = job.id || "-";
        jobStatusLabelEl.textContent = job.status || "unknown";
        jobProgressLabelEl.textContent = done + " / " + total + " (" + percent + "%)";
        jobProgressBarEl.style.width = percent + "%";
        jobLatestTaskEl.textContent = latest
          ? latest.locale + "/" + latest.breakpoint + " " + latest.status
          : "-";
      }

      function hidePostJobActions() {
        postJobActionsEl.classList.add("hidden");
      }

      function showPostJobActions(jobId) {
        postJobIdEl.textContent = jobId;
        postJobIdInlineEl.textContent = jobId;
        postJobBaseUrlEl.textContent = window.location.origin;
        postJobActionsEl.classList.remove("hidden");
      }

      function clearArtifacts() {
        artifactsEl.innerHTML = "";
      }

      function getFilteredRouteGroups() {
        const localeFilter = pageLocaleFilterEl.value;
        if (!localeFilter) {
          return discoveredRouteGroups;
        }
        return discoveredRouteGroups.filter((group) => !!group.locales[localeFilter]);
      }

      function populatePageLocaleFilter() {
        pageLocaleFilterEl.innerHTML = '<option value="">All locales</option>';
        for (const locale of discoveredLocales) {
          const option = document.createElement("option");
          option.value = locale;
          option.textContent = locale;
          pageLocaleFilterEl.appendChild(option);
        }
      }

      function renderPagesList() {
        pagesEl.innerHTML = "";
        const filteredGroups = getFilteredRouteGroups();
        if (filteredGroups.length === 0) {
          const empty = document.createElement("div");
          empty.className = "help";
          empty.textContent = "No routes match current locale filter.";
          pagesEl.appendChild(empty);
          return;
        }

        const grouped = new Map();
        for (const routeGroup of filteredGroups) {
          const route = routeGroup.displayPath || "/";
          const key = route === "/" ? "home" : route.split("/").filter(Boolean)[0] || "other";
          if (!grouped.has(key)) {
            grouped.set(key, []);
          }
          grouped.get(key).push(routeGroup);
        }

        const sortedGroups = [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b));
        for (const [groupName, routeGroups] of sortedGroups) {
          routeGroups.sort((a, b) => (a.displayPath || "/").localeCompare(b.displayPath || "/"));
          const details = document.createElement("details");
          details.open = groupName === "home";

          const summary = document.createElement("summary");
          summary.textContent = groupName + " (" + routeGroups.length + ")";
          details.appendChild(summary);

          for (const routeGroup of routeGroups) {
            const label = document.createElement("label");
            label.className = "route-option";

            const input = document.createElement("input");
            input.type = "checkbox";
            input.checked = selectedRouteIds.has(routeGroup.id);
            input.value = routeGroup.id;
            input.addEventListener("change", () => {
              if (input.checked) {
                selectedRouteIds.add(routeGroup.id);
              } else {
                selectedRouteIds.delete(routeGroup.id);
              }
            });

            const path = document.createElement("span");
            path.className = "route-path";
            path.textContent = routeGroup.displayPath || "/";

            const localeBadge = document.createElement("span");
            localeBadge.className = "route-locale";
            localeBadge.textContent = Object.keys(routeGroup.locales || {}).sort().join(", ");

            label.appendChild(input);
            label.appendChild(path);
            label.appendChild(localeBadge);
            details.appendChild(label);
          }

          pagesEl.appendChild(details);
        }
      }

      function resetArtifactFilters() {
        artifactLocaleFilterEl.innerHTML = '<option value="">All locales</option>';
        artifactBreakpointFilterEl.innerHTML = '<option value="">All breakpoints</option>';
      }

      function populateArtifactFilters(artifacts) {
        resetArtifactFilters();
        const locales = [...new Set(artifacts.map((artifact) => artifact.locale))].sort();
        const breakpoints = [...new Set(artifacts.map((artifact) => String(artifact.breakpoint)))].sort(
          (a, b) => Number(a) - Number(b)
        );
        for (const locale of locales) {
          const option = document.createElement("option");
          option.value = locale;
          option.textContent = locale;
          artifactLocaleFilterEl.appendChild(option);
        }
        for (const breakpoint of breakpoints) {
          const option = document.createElement("option");
          option.value = breakpoint;
          option.textContent = breakpoint;
          artifactBreakpointFilterEl.appendChild(option);
        }
      }

      function renderArtifacts() {
        clearArtifacts();
        const localeFilter = artifactLocaleFilterEl.value;
        const breakpointFilter = artifactBreakpointFilterEl.value;
        const filtered = allArtifacts.filter((artifact) => {
          if (localeFilter && artifact.locale !== localeFilter) {
            return false;
          }
          if (breakpointFilter && String(artifact.breakpoint) !== breakpointFilter) {
            return false;
          }
          return true;
        });
        for (const artifact of filtered) {
          const card = document.createElement("a");
          const relPath = artifact.path.startsWith("runs/") ? artifact.path.slice(5) : artifact.path;
          const encodedRelPath = relPath
            .split("/")
            .map((segment) => encodeURIComponent(segment))
            .join("/");
          card.className = "artifact-item";
          card.href = "/api/jobs/" + activeJobId + "/artifacts/" + encodedRelPath;
          card.target = "_blank";
          card.rel = "noreferrer";

          const img = document.createElement("img");
          img.loading = "lazy";
          img.src = card.href;
          img.alt = artifact.page + " " + artifact.locale + " " + artifact.breakpoint;

          const meta = document.createElement("div");
          meta.className = "artifact-meta";
          meta.textContent = artifact.locale + " · " + artifact.breakpoint + " · " + artifact.page;

          card.appendChild(img);
          card.appendChild(meta);
          artifactsEl.appendChild(card);
        }
      }

      async function loadArtifacts(jobId) {
        activeJobId = jobId;
        const res = await apiFetch("/api/jobs/" + jobId + "/artifacts");
        const json = await res.json();
        if (!res.ok) {
          allArtifacts = [];
          resetArtifactFilters();
          clearArtifacts();
          return;
        }
        allArtifacts = json.artifacts || [];
        populateArtifactFilters(allArtifacts);
        renderArtifacts();
      }

      async function pollJobUntilDone(jobId) {
        activePollToken += 1;
        const pollToken = activePollToken;
        for (let attempt = 0; attempt < 240; attempt += 1) {
          if (pollToken !== activePollToken) {
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 2500));
          const statusRes = await apiFetch("/api/jobs/" + jobId, { cache: "no-store" });
          const status = await statusRes.json();
          setJobMonitorState(status);
          if (attempt % 4 === 0 || status.status === "success" || status.status === "failed") {
            setOutput(status);
          }
          if (status.status === "success" || status.status === "failed") {
            const jobAccessToken =
              typeof status.accessToken === "string" && status.accessToken.length > 0
                ? status.accessToken
                : jobId;
            await loadArtifacts(jobAccessToken);
            showPostJobActions(jobAccessToken);
            return;
          }
        }
      }

      function parseCsv(value) {
        return value
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean);
      }

      function resetFileSelect() {
        figmaFileSelectEl.innerHTML = '<option value="">Select file</option>';
      }

      function setAllPageSelections(checked) {
        for (const routeGroup of getFilteredRouteGroups()) {
          if (checked) {
            selectedRouteIds.add(routeGroup.id);
          } else {
            selectedRouteIds.delete(routeGroup.id);
          }
        }
        renderPagesList();
      }

      function resetProjectSelect() {
        figmaProjectSelectEl.innerHTML = '<option value="">Select project</option>';
        resetFileSelect();
      }

      async function loadProjects() {
        const teamId = figmaTeamIdEl.value.trim();
        if (!teamId) {
          setOutput({ error: "Enter a Figma team id first." });
          return;
        }
        setOutput("Loading Figma projects...");
        resetProjectSelect();
        const res = await apiFetch("/api/figma/projects?teamId=" + encodeURIComponent(teamId));
        const json = await res.json();
        setOutput(json);
        if (!res.ok) {
          return;
        }
        for (const project of json.projects || []) {
          const option = document.createElement("option");
          option.value = project.id;
          option.textContent = project.name + " (" + project.id + ")";
          figmaProjectSelectEl.appendChild(option);
        }
      }

      async function loadFilesForProject(projectId) {
        resetFileSelect();
        if (!projectId) {
          return;
        }
        setOutput("Loading files...");
        const res = await apiFetch("/api/figma/projects/" + encodeURIComponent(projectId) + "/files");
        const json = await res.json();
        setOutput(json);
        if (!res.ok) {
          return;
        }
        for (const file of json.files || []) {
          const option = document.createElement("option");
          option.value = file.key;
          option.textContent = file.name + " (" + file.key + ")";
          figmaFileSelectEl.appendChild(option);
        }
      }

      function openTeamInFigma() {
        const teamId = figmaTeamIdEl.value.trim();
        if (!teamId) {
          setOutput({ error: "Enter team id first." });
          return;
        }
        window.open("https://www.figma.com/files/team/" + encodeURIComponent(teamId), "_blank", "noreferrer");
      }

      function openProjectInFigma() {
        const projectId = figmaProjectSelectEl.value.trim();
        if (!projectId) {
          setOutput({ error: "Select project first." });
          return;
        }
        window.open("https://www.figma.com/files/project/" + encodeURIComponent(projectId), "_blank", "noreferrer");
      }

      function openSelectedFileInFigma() {
        const fileKey = figmaFileSelectEl.value.trim();
        if (!fileKey) {
          setOutput({ error: "Select a Figma file first." });
          return;
        }
        window.open("https://www.figma.com/file/" + encodeURIComponent(fileKey), "_blank", "noreferrer");
      }

      document.getElementById("discoverBtn").addEventListener("click", async () => {
        setOutput("Discovering sitemap...");
        pagesEl.innerHTML = "";
        clearArtifacts();
        allArtifacts = [];
        activeJobId = "";
        resetArtifactFilters();
        const body = {
          baseUrl: document.getElementById("baseUrl").value,
          maxUrls: Number(document.getElementById("maxUrls").value || 200),
          maxSitemaps: Number(document.getElementById("maxSitemaps").value || 10)
        };
        const res = await apiFetch("/api/sitemap/discover", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body)
        });
        const json = await res.json();
        if (!res.ok) {
          setOutput(json);
          return;
        }
        discoveredRouteGroups = json.routeGroups || [];
        discoveredLocales = (json.discoveredLocales || []).slice().sort();
        selectedRouteIds.clear();
        for (const group of discoveredRouteGroups) {
          selectedRouteIds.add(group.id);
        }
        populatePageLocaleFilter();
        renderPagesList();
        const locales = discoveredLocales.length ? discoveredLocales.join(",") : "en";
        document.getElementById("locales").value = locales;
        setOutput(json);
      });

      document.getElementById("createJobBtn").addEventListener("click", async () => {
        const selectedLocales = parseCsv(document.getElementById("locales").value).map((value) =>
          value.toLowerCase()
        );
        const selectedGroups = discoveredRouteGroups.filter((group) => selectedRouteIds.has(group.id));
        const targets = [];
        for (const group of selectedGroups) {
          for (const locale of selectedLocales) {
            const url = group.locales?.[locale];
            if (!url) {
              continue;
            }
            targets.push({
              url,
              locale,
              routeKey: group.id
            });
          }
        }
        if (selectedGroups.length === 0) {
          setOutput({ error: "Select at least one route." });
          return;
        }
        if (targets.length === 0) {
          setOutput({
            error: "No locale-specific URLs available for current route+locale selection. Adjust locales or route filter."
          });
          return;
        }
        const payload = {
          pages: [],
          locales: selectedLocales,
          targets,
          breakpoints: parseCsv(document.getElementById("breakpoints").value).map((v) => Number(v))
        };
        setOutput("Creating job...");
        setJobMonitorState(null);
        hidePostJobActions();
        clearArtifacts();
        allArtifacts = [];
        activeJobId = "";
        resetArtifactFilters();
        const res = await apiFetch("/api/jobs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload)
        });
        const json = await res.json();
        setOutput(json);

        if (!json?.id) return;
        setJobMonitorState(json);
        pollJobUntilDone(json.id);
      });

      artifactLocaleFilterEl.addEventListener("change", renderArtifacts);
      artifactBreakpointFilterEl.addEventListener("change", renderArtifacts);
      document.getElementById("loadProjectsBtn").addEventListener("click", loadProjects);
      document.getElementById("reloadProjectsBtn").addEventListener("click", loadProjects);
      document.getElementById("openTeamInFigmaBtn").addEventListener("click", openTeamInFigma);
      document.getElementById("openProjectInFigmaBtn").addEventListener("click", openProjectInFigma);
      document.getElementById("copyJobIdBtn").addEventListener("click", async () => {
        const value = postJobIdEl.textContent || "";
        if (!value || value === "-") {
          return;
        }
        try {
          await navigator.clipboard.writeText(value);
          setOutput("Copied signed job id to clipboard.");
        } catch {
          setOutput({ error: "Clipboard write failed. Copy signed job id manually." });
        }
      });
      pageLocaleFilterEl.addEventListener("change", renderPagesList);
      document.getElementById("selectAllPagesBtn").addEventListener("click", () => setAllPageSelections(true));
      document.getElementById("selectNoPagesBtn").addEventListener("click", () => setAllPageSelections(false));
      document.getElementById("reloadFilesBtn").addEventListener("click", () => {
        loadFilesForProject(figmaProjectSelectEl.value);
      });
      figmaProjectSelectEl.addEventListener("change", (event) => {
        loadFilesForProject(event.target.value);
      });

      setJobMonitorState(null);
      hidePostJobActions();
    </script>
  </body>
</html>`;
}

function getDevUiConfig(): { figmaWriteState: string; importFlow: string } {
  return {
    figmaWriteState: "Disabled (capture-only jobs)",
    importFlow: "Plugin pulls artifacts via /api/jobs/:signedJobId/artifacts/*"
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
