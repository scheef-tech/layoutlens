type JobTask = {
  page: string;
  routeKey?: string;
  locale: string;
  breakpoint: number;
  status: "success" | "skipped" | "failed";
  message: string;
  artifactPath?: string;
};

type ImportJob = {
  id: string;
  status: string;
  tasks: JobTask[];
};

type JobsListResponse = {
  jobs: Array<{ id: string; status: string }>;
};

type UiSubmit = {
  type: "submit";
  baseUrl: string;
  jobId: string;
};

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function parseRouteLabel(pageUrl: string): string {
  try {
    const parsed = new URL(pageUrl);
    return parsed.pathname === "/" ? "home" : parsed.pathname.replace(/^\/+/, "");
  } catch {
    return pageUrl;
  }
}

function toCanonicalRouteId(task: JobTask): string {
  const routeKey = task.routeKey?.trim().toLowerCase();
  if (routeKey) {
    return routeKey;
  }
  try {
    const parsed = new URL(task.page);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const first = segments[0]?.toLowerCase();
    const locale = task.locale.toLowerCase();
    const withoutLocale = first === locale ? segments.slice(1) : segments;
    if (withoutLocale.length === 0) {
      return "home";
    }
    return withoutLocale.join("/").toLowerCase();
  } catch {
    return parseRouteLabel(task.page).toLowerCase();
  }
}

function routePageName(routeId: string): string {
  if (routeId === "home") {
    return "home";
  }
  return routeId;
}

function getOrCreatePage(name: string): PageNode {
  const existing = figma.root.children.find((node) => node.type === "PAGE" && node.name === name);
  if (existing && existing.type === "PAGE") {
    existing.name = name;
    return existing;
  }
  const created = figma.createPage();
  created.name = name;
  return created;
}

function artifactRelativePath(artifactPath: string): string {
  return artifactPath.startsWith("runs/") ? artifactPath.slice(5) : artifactPath;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Request failed (${res.status}) for ${url}`);
  }
  return (await res.json()) as T;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Image fetch failed (${res.status}) for ${url}`);
  }
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

async function placeImageInto(
  parent: FrameNode,
  bytes: Uint8Array,
  name: string,
  offsetY: number,
  width: number,
  height: number
): Promise<void> {
  const image = figma.createImage(bytes);
  const rect = figma.createRectangle();
  rect.name = name;
  rect.fills = [{ type: "IMAGE", scaleMode: "FILL", imageHash: image.hash }];
  rect.resize(width, height);
  rect.y = offsetY;
  parent.appendChild(rect);
}

function buildArtifactPath(baseUrl: string, jobId: string, artifactPath: string): string {
  const cleanBase = normalizeBaseUrl(baseUrl);
  const relativePath = artifactRelativePath(artifactPath);
  const encodedPath = relativePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${cleanBase}/api/jobs/${encodeURIComponent(jobId)}/artifacts/${encodedPath}`;
}

async function resolveJob(baseUrl: string, requestedJobId: string): Promise<ImportJob> {
  const cleanBase = normalizeBaseUrl(baseUrl);
  const jobId = requestedJobId.trim();
  if (jobId.length > 0) {
    return fetchJson<ImportJob>(`${cleanBase}/api/jobs/${encodeURIComponent(jobId)}`);
  }

  const jobs = await fetchJson<JobsListResponse>(`${cleanBase}/api/jobs`);
  const latest = jobs.jobs.find((j) => j.status === "success" || j.status === "failed");
  if (!latest) {
    throw new Error("No jobs found on server.");
  }
  return fetchJson<ImportJob>(`${cleanBase}/api/jobs/${encodeURIComponent(latest.id)}`);
}

async function importJobToCanvas(baseUrl: string, job: ImportJob): Promise<number> {
  let importedCount = 0;
  const MAX_SOURCE_SLICE_HEIGHT = 4096;

  // Group screenshots by canonical route, then by locale.
  const routeGroups = new Map<string, Map<string, JobTask[]>>();
  for (const task of job.tasks) {
    if (!task.artifactPath) {
      continue;
    }
    const routeId = toCanonicalRouteId(task);
    if (!routeGroups.has(routeId)) {
      routeGroups.set(routeId, new Map());
    }
    const byLocale = routeGroups.get(routeId)!;
    if (!byLocale.has(task.locale)) {
      byLocale.set(task.locale, []);
    }
    byLocale.get(task.locale)!.push(task);
  }

  const sortedRouteIds = Array.from(routeGroups.keys()).sort((a, b) => a.localeCompare(b));
  let firstTargetPage: PageNode | undefined;
  const SECTION_GAP_X = 120;
  const SECTION_GAP_Y = 80;
  const FRAME_GAP = 48;

  for (const routeId of sortedRouteIds) {
    const pageName = routePageName(routeId);
    const page = getOrCreatePage(pageName);
    if (!firstTargetPage) {
      firstTargetPage = page;
    }
    let sectionX = 0;
    let sectionY = 0;

    const localeEntries: Array<[string, JobTask[]]> = Array.from(routeGroups.get(routeId)!.entries()).sort(
      ([a], [b]) => a.localeCompare(b)
    );
    for (const [locale, tasks] of localeEntries) {
      tasks.sort((a: JobTask, b: JobTask) => a.breakpoint - b.breakpoint);

      const section = figma.createFrame();
      section.name = `${pageName} · ${locale}`;
      section.layoutMode = "VERTICAL";
      section.counterAxisSizingMode = "AUTO";
      section.primaryAxisSizingMode = "AUTO";
      section.itemSpacing = 24;
      section.paddingTop = 24;
      section.paddingRight = 24;
      section.paddingBottom = 24;
      section.paddingLeft = 24;
      section.x = sectionX;
      section.y = sectionY;
      section.fills = [];

      const row = figma.createFrame();
      row.name = "breakpoints";
      row.layoutMode = "HORIZONTAL";
      row.counterAxisSizingMode = "AUTO";
      row.primaryAxisSizingMode = "AUTO";
      row.itemSpacing = FRAME_GAP;
      row.fills = [];
      section.appendChild(row);

      for (const task of tasks) {
        const artifactUrl = buildArtifactPath(baseUrl, job.id, task.artifactPath!);
        const meta = await fetchJson<{ width: number; height: number }>(`${artifactUrl}?meta=1`);
        const displayWidth = Math.max(1, Math.round(task.breakpoint));
        const scale = displayWidth / Math.max(1, meta.width);

        const frame = figma.createFrame();
        frame.name = `${task.breakpoint}`;
        frame.layoutMode = "VERTICAL";
        frame.counterAxisSizingMode = "AUTO";
        frame.primaryAxisSizingMode = "AUTO";
        frame.itemSpacing = 8;
        frame.fills = [];

        let currentY = 0;
        if (meta.height > MAX_SOURCE_SLICE_HEIGHT) {
          let sliceTop = 0;
          while (sliceTop < meta.height) {
            const sliceHeight = Math.min(MAX_SOURCE_SLICE_HEIGHT, meta.height - sliceTop);
            const bytes = await fetchBytes(
              `${artifactUrl}?sliceTop=${sliceTop}&sliceHeight=${sliceHeight}`
            );
            const displayHeight = Math.max(1, Math.round(sliceHeight * scale));
            await placeImageInto(
              frame,
              bytes,
              `${locale} · ${task.breakpoint} · y=${sliceTop}`,
              currentY,
              displayWidth,
              displayHeight
            );
            currentY += displayHeight + 16;
            sliceTop += sliceHeight;
          }
        } else {
          const bytes = await fetchBytes(artifactUrl);
          const displayHeight = Math.max(1, Math.round(meta.height * scale));
          await placeImageInto(frame, bytes, `${locale} · ${task.breakpoint}`, currentY, displayWidth, displayHeight);
          currentY += displayHeight;
        }

        row.appendChild(frame);
        importedCount += 1;
      }

      page.appendChild(section);
      sectionX += section.width + SECTION_GAP_X;
      if (sectionX > 6000) {
        sectionX = 0;
        sectionY += section.height + SECTION_GAP_Y;
      }
    }
  }

  if (firstTargetPage) {
    figma.currentPage = firstTargetPage;
  }

  return importedCount;
}

function showConfigUi(defaultBaseUrl: string): Promise<{ baseUrl: string; jobId: string }> {
  return new Promise((resolve) => {
    figma.showUI(
      `
<style>
  body { font-family: Inter, system-ui, sans-serif; margin: 16px; }
  label { display: block; font-size: 12px; margin-bottom: 4px; color: #444; }
  input { width: 100%; margin-bottom: 12px; padding: 8px; border: 1px solid #ccc; border-radius: 6px; }
  button { width: 100%; padding: 10px; border: 0; border-radius: 6px; background: #2f7cff; color: white; font-weight: 600; cursor: pointer; }
  p { font-size: 12px; color: #666; }
</style>
<label>Microservice Base URL</label>
<input id="baseUrl" value="${defaultBaseUrl}" />
<label>Job ID (optional)</label>
<input id="jobId" placeholder="Leave empty to use latest job" />
<button id="importBtn">Import</button>
<p>If Job ID is empty, plugin imports the latest finished job from the server.</p>
<script>
  document.getElementById("importBtn").addEventListener("click", () => {
    parent.postMessage({ pluginMessage: {
      type: "submit",
      baseUrl: document.getElementById("baseUrl").value,
      jobId: document.getElementById("jobId").value
    }}, "*");
  });
</script>
      `,
      { width: 380, height: 240 }
    );

    figma.ui.onmessage = (message: UiSubmit) => {
      if (message.type === "submit") {
        resolve({ baseUrl: message.baseUrl.trim(), jobId: message.jobId.trim() });
      }
    };
  });
}

export default async function () {
  try {
    const stored = (await figma.clientStorage.getAsync("layoutlensBaseUrl")) as string | undefined;
    const defaultBaseUrl = stored && stored.length > 0 ? stored : "http://localhost:8787";

    const config = await showConfigUi(defaultBaseUrl);
    await figma.clientStorage.setAsync("layoutlensBaseUrl", config.baseUrl);

    const job = await resolveJob(config.baseUrl, config.jobId);
    const imported = await importJobToCanvas(config.baseUrl, job);

    figma.viewport.scrollAndZoomIntoView(figma.currentPage.children);
    figma.notify(`Imported ${imported} screenshots from job ${job.id}`);
    figma.closePlugin();
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : JSON.stringify(error);
    figma.notify(message, { timeout: 6000 });
    figma.closePlugin(message);
  }
}
