// A tiny Bun server that serves a run directory for the Figma plugin importer.
// Endpoints:
// - GET /manifest -> returns manifest.json with each Shot.path rewritten to a fetchable URL under /file?abs=...
// - GET /file?abs=<absolute path> -> streams the file if it resides within runDir

type RunManifest = {
  id: string;
  url: string;
  breakpoints: number[];
  locales: string[];
  out_dir: string;
  shots: Array<{
    locale: string;
    breakpoint: number;
    path: string;
  }>;
};

const [, , runDirArg, portArg] = process.argv;
if (!runDirArg) {
  console.error("Usage: bun scripts/serve-run.ts <runDir> [port]");
  process.exit(1);
}
const runDir = runDirArg;
const port = Number(portArg || 7777);

function normalizePath(p: string): string {
  try {
    return new URL("file://" + p).pathname;
  } catch {
    return p;
  }
}

function isPathInside(parent: string, child: string): boolean {
  const a = normalizePath(parent).replace(/\/+$/, "");
  const b = normalizePath(child);
  return b === a || b.startsWith(a + "/");
}

function corsHeaders(extra: Record<string, string> = {}): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    ...extra,
  };
}

async function handleManifest(): Promise<Response> {
  const manifestPath = `${runDir}/manifest.json`;
  const file = Bun.file(manifestPath);
  if (!(await file.exists())) {
    return new Response("Not Found", { status: 404, headers: corsHeaders() });
  }
  const json = (await file.json()) as RunManifest;
  const rewritten = {
    ...json,
    // Provide a hint for the plugin where this server is
    _servedBy: `http://localhost:${port}`,
    shots: json.shots.map((s) => ({
      ...s,
      // Rewrite to a fetchable URL from the plugin environment
      path: `/file?abs=${encodeURIComponent(s.path)}`,
    })),
  };
  return new Response(JSON.stringify(rewritten), {
    headers: corsHeaders({ "content-type": "application/json" }),
  });
}

async function getImageDims(
  absPath: string
): Promise<{ width: number; height: number } | null> {
  try {
    const proc = Bun.spawn(
      ["/usr/bin/sips", "-g", "pixelWidth", "-g", "pixelHeight", absPath],
      { stdout: "pipe", stderr: "pipe" }
    );
    const out = await new Response(proc.stdout).text();
    const wMatch = out.match(/pixelWidth:\s*(\d+)/);
    const hMatch = out.match(/pixelHeight:\s*(\d+)/);
    if (!wMatch || !hMatch) return null;
    return { width: Number(wMatch[1]), height: Number(hMatch[1]) };
  } catch {
    return null;
  }
}

async function handleMeta(url: URL): Promise<Response> {
  const abs = url.searchParams.get("abs");
  if (!abs)
    return new Response("Bad Request", { status: 400, headers: corsHeaders() });
  const decoded = decodeURIComponent(abs);
  if (!isPathInside(runDir, decoded)) {
    return new Response("Forbidden", { status: 403, headers: corsHeaders() });
  }
  const dims = await getImageDims(decoded);
  if (!dims)
    return new Response("Not Found", { status: 404, headers: corsHeaders() });
  return new Response(JSON.stringify(dims), {
    headers: corsHeaders({ "content-type": "application/json" }),
  });
}

async function handleFile(url: URL): Promise<Response> {
  const abs = url.searchParams.get("abs");
  if (!abs)
    return new Response("Bad Request", { status: 400, headers: corsHeaders() });
  const decoded = decodeURIComponent(abs);
  if (!isPathInside(runDir, decoded)) {
    return new Response("Forbidden", { status: 403, headers: corsHeaders() });
  }
  const f = Bun.file(decoded);
  if (!(await f.exists()))
    return new Response("Not Found", { status: 404, headers: corsHeaders() });
  // Vertical slice if requested to avoid Figma 4K limit
  const sliceTop = url.searchParams.get("sliceTop");
  const sliceHeight = url.searchParams.get("sliceHeight");
  if (sliceTop || sliceHeight) {
    try {
      const top = Math.max(0, Number(sliceTop || 0) || 0);
      const h = Math.max(1, Math.min(4096, Number(sliceHeight || 0) || 0));
      const dims = await getImageDims(decoded);
      if (!dims)
        return new Response("Meta failed", {
          status: 500,
          headers: corsHeaders(),
        });
      const width = dims.width;
      const height = dims.height;
      const { mkdir, stat } = await import("node:fs/promises");
      const path = await import("node:path");
      const crypto = await import("node:crypto");
      const cacheDir = path.join(runDir, ".cache");
      await mkdir(cacheDir, { recursive: true });
      const hash = crypto
        .createHash("sha1")
        .update(`${decoded}_${top}_${h}`)
        .digest("hex");
      const outPath = path.join(cacheDir, `${hash}_slice.jpg`);
      let needsBuild = false;
      try {
        await stat(outPath);
      } catch {
        needsBuild = true;
      }
      if (needsBuild) {
        // Try ffmpeg first (top-left coordinates crop), fallback to sips
        const ffmpegBins = [
          "/opt/homebrew/bin/ffmpeg",
          "/usr/local/bin/ffmpeg",
          "/usr/bin/ffmpeg",
          "ffmpeg",
        ];
        let cropped = false;
        for (const bin of ffmpegBins) {
          try {
            const p = Bun.spawn(
              [
                bin,
                "-y",
                "-i",
                decoded,
                "-vf",
                `crop=${width}:${h}:0:${top}`,
                "-frames:v",
                "1",
                "-q:v",
                "2",
                outPath,
              ],
              { stdout: "pipe", stderr: "pipe" }
            );
            const code = await p.exited;
            if (typeof code === "number" ? code === 0 : !p.killed) {
              cropped = true;
              break;
            }
          } catch (_) {
            /* try next */
          }
        }
        if (!cropped) {
          // sips fallback: convert top-offset to bottom-left offset
          const yOffset = Math.max(0, height - top - h);
          const proc = Bun.spawn(
            [
              "/usr/bin/sips",
              decoded,
              "--cropOffset",
              "0",
              String(yOffset),
              "-c",
              String(h),
              String(width),
              "-s",
              "format",
              "jpeg",
              "-s",
              "formatOptions",
              "100",
              "--out",
              outPath,
            ],
            { stdout: "pipe", stderr: "pipe" }
          );
          const _status = await proc.exited;
        }
      }
      const resized = Bun.file(outPath);
      if (await resized.exists()) {
        return new Response(resized, {
          headers: corsHeaders({ "content-type": "image/jpeg" }),
        });
      }
    } catch (_) {
      // fall through to original
    }
  }
  // No width downscaling for full images; serve original file
  const type = (await f.type) || "application/octet-stream";
  return new Response(f, { headers: corsHeaders({ "content-type": type }) });
}

const server = Bun.serve({
  port,
  fetch: async (req) => {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (url.pathname === "/meta") {
      return handleMeta(url);
    }
    if (url.pathname === "/manifest" || url.pathname === "/manifest.json") {
      return handleManifest();
    }
    if (url.pathname === "/file") {
      return handleFile(url);
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = `<!doctype html><html><head><meta charset="utf-8"/><title>LayoutLens Run Server</title></head><body><h1>LayoutLens Run Server</h1><p>Use <code>/manifest</code> to fetch the manifest and <code>/file?abs=</code> to fetch files.</p></body></html>`;
      return new Response(html, {
        headers: corsHeaders({ "content-type": "text/html" }),
      });
    }
    return new Response("Not Found", { status: 404, headers: corsHeaders() });
  },
});

console.log(`Serving ${runDir} at http://localhost:${port}`);

export {};
