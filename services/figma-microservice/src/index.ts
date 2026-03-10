import { Hono } from "hono";
import { cors } from "hono/cors";
import { stat } from "node:fs/promises";
import { join, normalize, resolve } from "node:path";
import { createJob, getJob, listJobs } from "./job-store";
import { discoverLocalesFromUrls, discoverSitemaps } from "./sitemap";
import type { CreateJobRequest, DiscoverSitemapRequest } from "./types";

const app = new Hono();

app.use("*", cors());

app.get("/health", (c) =>
  c.json({
    ok: true,
    service: "layoutlens-figma-microservice",
    now: new Date().toISOString()
  })
);

app.post("/api/sitemap/discover", async (c) => {
  const payload = await c.req.json<DiscoverSitemapRequest>().catch(() => null);
  if (!payload?.baseUrl) {
    return c.json({ error: "baseUrl is required" }, 400);
  }

  const discovered = await discoverSitemaps(
    payload.baseUrl,
    payload.maxUrls ?? 500,
    payload.maxSitemaps ?? 20
  );
  const discoveredLocales = discoverLocalesFromUrls(discovered.pageUrls);

  return c.json({
    sourceSitemaps: discovered.sourceSitemaps,
    pageUrls: discovered.pageUrls,
    discoveredLocales
  });
});

app.post("/api/jobs", async (c) => {
  const payload = await c.req.json<CreateJobRequest>().catch(() => null);
  if (!payload) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  if (!payload.figmaFileKey) {
    return c.json({ error: "figmaFileKey is required" }, 400);
  }
  if (!Array.isArray(payload.pages) || payload.pages.length === 0) {
    return c.json({ error: "pages must contain at least one URL" }, 400);
  }
  if (!Array.isArray(payload.locales) || payload.locales.length === 0) {
    return c.json({ error: "locales must contain at least one locale" }, 400);
  }
  if (!Array.isArray(payload.breakpoints) || payload.breakpoints.length === 0) {
    return c.json({ error: "breakpoints must contain at least one value" }, 400);
  }

  const cleanBreakpoints = payload.breakpoints
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);

  if (cleanBreakpoints.length === 0) {
    return c.json({ error: "No valid breakpoints provided" }, 400);
  }

  const job = createJob({
    ...payload,
    breakpoints: cleanBreakpoints
  });
  return c.json(job, 201);
});

app.get("/api/jobs", (c) => c.json({ jobs: listJobs() }));

app.get("/api/jobs/:jobId", (c) => {
  const job = getJob(c.req.param("jobId"));
  if (!job) {
    return c.json({ error: "Job not found" }, 404);
  }
  return c.json(job);
});

app.get("/api/jobs/:jobId/artifacts", async (c) => {
  const job = getJob(c.req.param("jobId"));
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
  return c.json({ artifacts });
});

app.get("/api/jobs/:jobId/artifacts/*", async (c) => {
  const jobId = c.req.param("jobId");
  const relativePath = c.req.path.replace(`/api/jobs/${jobId}/artifacts/`, "");
  const runsRoot = resolve(process.env.RUNS_DIR?.trim() || "runs");
  const targetPath = resolve(join(runsRoot, normalize(relativePath)));
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

  return new Response(Bun.file(targetPath), {
    headers: {
      "Content-Type": "image/png"
    }
  });
});

app.get("/dev", (c) => {
  if (!isAuthorizedForDevUi(c.req.header("authorization"))) {
    return new Response("Unauthorized", {
      status: 401,
      headers: {
        "WWW-Authenticate": 'Basic realm="LayoutLens Dev UI"'
      }
    });
  }
  return c.html(renderDevUi());
});

const port = Number(process.env.PORT || 8787);
console.log(`layoutlens-figma-microservice listening on http://localhost:${port}`);

export default {
  port,
  fetch: app.fetch
};

function isAuthorizedForDevUi(authorizationHeader: string | undefined): boolean {
  const expected = process.env.DEV_UI_BASIC_AUTH?.trim();
  if (!expected) {
    return true;
  }

  if (!authorizationHeader?.startsWith("Basic ")) {
    return false;
  }

  const encoded = authorizationHeader.slice("Basic ".length).trim();
  let decoded: string;
  try {
    decoded = atob(encoded);
  } catch {
    return false;
  }
  return decoded === expected;
}

function renderDevUi(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>LayoutLens Figma Microservice</title>
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
      input, textarea, button {
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
    <h1>LayoutLens → Figma (Microservice Dev UI)</h1>
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
        <div id="pages" class="pages"></div>
      </section>

      <section class="card">
        <h2>Job Creation</h2>
        <label>Figma file key</label>
        <input id="figmaFileKey" placeholder="ABCD1234..." />
        <label>Figma target node id (for dev resource links)</label>
        <input id="figmaNodeId" placeholder="1:2" />
        <label>Artifact public base URL (optional)</label>
        <input id="artifactPublicBaseUrl" placeholder="https://your-service.example.com" />
        <label>Breakpoints (comma-separated)</label>
        <input id="breakpoints" value="375,768,1440" />
        <button id="createJobBtn">Create import job</button>
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
      const artifactLocaleFilterEl = document.getElementById("artifactLocaleFilter");
      const artifactBreakpointFilterEl = document.getElementById("artifactBreakpointFilter");
      let allArtifacts = [];
      let activeJobId = "";

      function setOutput(value) {
        outputEl.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      }

      function clearArtifacts() {
        artifactsEl.innerHTML = "";
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
          const relPath = artifact.path.replace(/^runs\//, "");
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
        const res = await fetch("/api/jobs/" + jobId + "/artifacts");
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

      function parseCsv(value) {
        return value
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean);
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
        const res = await fetch("/api/sitemap/discover", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body)
        });
        const json = await res.json();
        if (!res.ok) {
          setOutput(json);
          return;
        }
        const locales = json.discoveredLocales?.length ? json.discoveredLocales.join(",") : "en";
        document.getElementById("locales").value = locales;
        for (const page of json.pageUrls || []) {
          const label = document.createElement("label");
          const input = document.createElement("input");
          input.type = "checkbox";
          input.checked = true;
          input.value = page;
          label.appendChild(input);
          label.appendChild(document.createTextNode(page));
          pagesEl.appendChild(label);
        }
        setOutput(json);
      });

      document.getElementById("createJobBtn").addEventListener("click", async () => {
        const pages = [...pagesEl.querySelectorAll('input[type="checkbox"]:checked')].map((el) => el.value);
        const payload = {
          figmaFileKey: document.getElementById("figmaFileKey").value.trim(),
          figmaNodeId: document.getElementById("figmaNodeId").value.trim() || undefined,
          artifactPublicBaseUrl:
            document.getElementById("artifactPublicBaseUrl").value.trim() || undefined,
          pages,
          locales: parseCsv(document.getElementById("locales").value),
          breakpoints: parseCsv(document.getElementById("breakpoints").value).map((v) => Number(v))
        };
        setOutput("Creating job...");
        clearArtifacts();
        allArtifacts = [];
        activeJobId = "";
        resetArtifactFilters();
        const res = await fetch("/api/jobs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload)
        });
        const json = await res.json();
        setOutput(json);

        if (!json?.id) return;
        let attempts = 0;
        while (attempts < 60) {
          attempts += 1;
          await new Promise((resolve) => setTimeout(resolve, 1000));
          const statusRes = await fetch("/api/jobs/" + json.id);
          const status = await statusRes.json();
          setOutput(status);
          if (status.status === "success" || status.status === "failed") {
            await loadArtifacts(json.id);
            break;
          }
        }
      });

      artifactLocaleFilterEl.addEventListener("change", renderArtifacts);
      artifactBreakpointFilterEl.addEventListener("change", renderArtifacts);
    </script>
  </body>
</html>`;
}
