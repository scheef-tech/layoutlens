import {
  chromium,
  firefox,
  webkit,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import { mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";

type Config = {
  url: string;
  breakpoints: number[];
  locales: string[];
  cookie: {
    name: string;
    domain?: string;
    path?: string;
    sameSite?: "Lax" | "Strict" | "None";
    secure?: boolean;
    httpOnly?: boolean;
  };
  behavior: {
    sendAcceptLanguage?: boolean;
    urlTemplate?: string | null;
    useUrlTemplate?: boolean;
  };
  outDir: string;
  engine?: "chromium" | "webkit" | "firefox";
  // Optional: use a persistent profile directory to enable disk cache reuse across runs
  profileDir?: string | null;
  // Optional: limit concurrent pages per locale to avoid network thrashing
  maxConcurrentPages?: number;
};

async function run(cfg: Config) {
  // Create a single shared context so HTTP cache is reused across all pages/locales
  let browser: Browser | null = null;
  let context: BrowserContext;

  const usePersistent = Boolean(cfg.profileDir);
  if (cfg.engine === "webkit") {
    if (usePersistent) {
      context = await webkit.launchPersistentContext(String(cfg.profileDir));
    } else {
      browser = await webkit.launch();
      context = await browser.newContext();
    }
  } else if (cfg.engine === "firefox") {
    if (usePersistent) {
      context = await firefox.launchPersistentContext(String(cfg.profileDir));
    } else {
      browser = await firefox.launch();
      context = await browser.newContext();
    }
  } else {
    if (usePersistent) {
      context = await chromium.launchPersistentContext(String(cfg.profileDir));
    } else {
      browser = await chromium.launch();
      context = await browser.newContext();
    }
  }

  const manifest: any = {
    id: String(Date.now()),
    url: cfg.url,
    breakpoints: cfg.breakpoints,
    locales: cfg.locales,
    cookie: cfg.cookie,
    behavior: cfg.behavior,
    out_dir: cfg.outDir,
    shots: [] as any[],
  };

  mkdirSync(cfg.outDir, { recursive: true });

  // Process locales sequentially to avoid cookie races while still sharing the cache
  for (const locale of cfg.locales) {
    const headers: Record<string, string> = {};
    if (cfg.behavior.sendAcceptLanguage) {
      headers["Accept-Language"] = locale;
    }
    await context.setExtraHTTPHeaders(headers);

    const base = new URL(cfg.url.trim());
    const host = base.hostname || "localhost";
    const isLocalhost = host === "localhost" || host === "127.0.0.1";
    const domain = cfg.cookie.domain || host;
    const path = cfg.cookie.path ?? "/";
    const requestedSameSite = cfg.cookie.sameSite ?? "Lax";
    const sameSite = requestedSameSite;
    const secure =
      requestedSameSite === "None" ? !isLocalhost : Boolean(cfg.cookie.secure);
    const httpOnly = Boolean(cfg.cookie.httpOnly);

    // Ensure we only have the intended locale cookie set
    await context.clearCookies();
    await context.addCookies([
      {
        name: cfg.cookie.name,
        value: locale,
        domain,
        path,
        sameSite: sameSite as any,
        secure,
        httpOnly,
      },
    ]);

    const dir = join(cfg.outDir, locale);
    mkdirSync(dir, { recursive: true });

    const concurrency = Math.max(
      1,
      Math.min(cfg.maxConcurrentPages ?? 4, cfg.breakpoints.length)
    );
    await runWithConcurrency(cfg.breakpoints, concurrency, async (bp) => {
      const page = await context.newPage();
      try {
        const url = buildUrl(cfg.url, cfg.behavior, locale);
        await page.setViewportSize({ width: bp, height: 1000 });
        await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
        await autoScroll(page);
        await waitForImages(page);
        const out = join(dir, `${bp}.png`);
        await page.screenshot({ path: out, fullPage: true });
        manifest.shots.push({
          locale,
          breakpoint: bp,
          path: out,
          width: bp,
          height: 0,
          ok: true,
        });
      } finally {
        await page.close();
      }
    });
  }

  writeFileSync(
    join(cfg.outDir, "manifest.json"),
    JSON.stringify(manifest, null, 2)
  );
  if (browser) {
    await context.close();
    await browser.close();
  } else {
    await context.close();
  }
}

async function autoScroll(page: Page) {
  await page.evaluate(async () => {
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const getMaxScroll = () =>
      Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight
      );
    const viewport = window.innerHeight || 800;
    const step = Math.max(Math.floor(viewport * 0.8), 200);
    let prev = -1;
    for (let y = 0; y < getMaxScroll(); y += step) {
      window.scrollTo(0, y);
      await delay(120);
      const cur = getMaxScroll();
      if (cur === prev) continue;
      prev = cur;
    }
    // Ensure bottom reached
    window.scrollTo(0, getMaxScroll());
    await delay(200);
    // Return to top for consistent screenshots
    window.scrollTo(0, 0);
    await delay(100);
  });
}

async function waitForImages(page: Page) {
  await page.evaluate(async () => {
    const imgs = Array.from(document.images);
    await Promise.all(
      imgs.map((img) => {
        if (img.complete && img.naturalWidth > 0) return Promise.resolve();
        return new Promise<void>((resolve) => {
          const done = () => resolve();
          img.addEventListener("load", done, { once: true });
          img.addEventListener("error", done, { once: true });
        });
      })
    );
  });
}

function buildUrl(
  baseUrl: string,
  behavior: Config["behavior"],
  locale: string
) {
  if (behavior.useUrlTemplate && behavior.urlTemplate) {
    const u = new URL(baseUrl);
    const pathname = u.pathname + u.search + u.hash;
    let template = behavior.urlTemplate;
    template = template
      .replace("{locale}", locale)
      .replace("{pathname}", pathname);
    if (template.startsWith("/")) {
      u.pathname = template;
      u.search = "";
      u.hash = "";
      return u.toString();
    }
    if (template.startsWith("?")) {
      u.search = template;
      return u.toString();
    }
  }
  return baseUrl;
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>
) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }).map(
    async () => {
      while (queue.length) {
        const next = queue.shift() as T;
        await worker(next);
      }
    }
  );
  await Promise.all(workers);
}

if (import.meta.main) {
  const json = process.argv[2];
  if (!json) {
    console.error("Expected JSON config path as argv[2]");
    process.exit(1);
  }
  const cfg = JSON.parse(readFileSync(json, "utf-8")) as Config;
  run(cfg).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
