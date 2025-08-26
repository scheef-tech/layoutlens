import { chromium, firefox, webkit, type Browser, type Page } from "playwright";
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
};

async function run(cfg: Config) {
  const browser: Browser = await (cfg.engine === "webkit"
    ? webkit.launch()
    : cfg.engine === "firefox"
    ? firefox.launch()
    : chromium.launch());

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

  // Parallelize per-locale and per-breakpoint work aggressively
  await Promise.all(
    cfg.locales.map(async (locale) => {
      const headers = cfg.behavior.sendAcceptLanguage
        ? { "Accept-Language": locale }
        : undefined;
      const context = await browser.newContext({ extraHTTPHeaders: headers });

      const base = new URL(cfg.url.trim());
      const host = base.hostname || "localhost";
      const isLocalhost = host === "localhost" || host === "127.0.0.1";
      const domain = cfg.cookie.domain || host;
      const path = cfg.cookie.path ?? "/";
      // Chromium blocks SameSite=None without Secure. For localhost we can keep Secure=false.
      const requestedSameSite = cfg.cookie.sameSite ?? "Lax";
      const sameSite = requestedSameSite;
      const secure =
        requestedSameSite === "None"
          ? !isLocalhost
          : Boolean(cfg.cookie.secure);
      const httpOnly = Boolean(cfg.cookie.httpOnly);
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

      // Open multiple pages concurrently for breakpoints
      const dir = join(cfg.outDir, locale);
      mkdirSync(dir, { recursive: true });

      await Promise.all(
        cfg.breakpoints.map(async (bp) => {
          const page = await context.newPage();
          try {
            const url = buildUrl(cfg.url, cfg.behavior, locale);
            await page.setViewportSize({ width: bp, height: 1000 });
            await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
            // Trigger lazy-loaded content by scrolling through the page
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
        })
      );

      await context.close();
    })
  );

  writeFileSync(
    join(cfg.outDir, "manifest.json"),
    JSON.stringify(manifest, null, 2)
  );
  await browser.close();
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
