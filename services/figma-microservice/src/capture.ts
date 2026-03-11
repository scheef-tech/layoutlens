import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { chromium, type BrowserContext } from "playwright";
import type { CreateJobRequest, PageSelection } from "./types";
import { getEnv, getEnvInt, getEnvOr } from "./env";

export type CaptureResult = {
  artifactPath: string;
  width: number;
  height: number;
};

function toSafeSlug(input: string): string {
  return input
    .replaceAll(/[^a-zA-Z0-9_-]+/g, "-")
    .replaceAll(/-+/g, "-")
    .replaceAll(/^-|-$/g, "")
    .toLowerCase();
}

function toRouteSlug(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "home" : parsed.pathname;
    return toSafeSlug(`${parsed.hostname}${path}`);
  } catch {
    return toSafeSlug(url);
  }
}

function getBaseRunsDir(): string {
  return getEnvOr("RUNS_DIR", "runs");
}

function getLocaleCookieConfig(
  request: CreateJobRequest,
  selection: PageSelection
): {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: "Lax" | "Strict" | "None";
} | null {
  const explicit = request.localeCookie;
  const envName = getEnv("LOCALE_COOKIE_NAME");
  const cookieName = explicit?.name || envName;
  if (!cookieName) {
    return null;
  }

  const targetUrl = new URL(selection.url);
  return {
    name: cookieName,
    value: selection.locale,
    domain: explicit?.domain || targetUrl.hostname,
    path: explicit?.path || "/",
    secure: explicit?.secure ?? targetUrl.protocol === "https:",
    httpOnly: explicit?.httpOnly ?? false,
    sameSite: explicit?.sameSite ?? "Lax"
  };
}

export async function captureSelection(
  request: CreateJobRequest,
  jobId: string,
  selection: PageSelection
): Promise<CaptureResult> {
  const runner = await createCaptureRunner(request, jobId);
  try {
    return await runner.capture(selection);
  } finally {
    await runner.close();
  }
}

export type CaptureRunner = {
  capture: (selection: PageSelection) => Promise<CaptureResult>;
  close: () => Promise<void>;
};

async function warmPageByScrolling(page: Awaited<ReturnType<BrowserContext["newPage"]>>): Promise<void> {
  const settleMs = Math.max(0, getEnvInt("CAPTURE_SCROLL_SETTLE_MS", 180));
  const maxPasses = Math.max(1, getEnvInt("CAPTURE_SCROLL_MAX_PASSES", 3));

  await page.evaluate(
    async ({ settleMs: settleDelay, maxPasses: maxScrollPasses }) => {
      const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      const root = document.scrollingElement || document.documentElement;

      for (let pass = 0; pass < maxScrollPasses; pass += 1) {
        let previousHeight = 0;
        let sameHeightCount = 0;
        let guard = 0;

        while (guard < 800) {
          guard += 1;
          const currentHeight = root.scrollHeight;
          const currentY = window.scrollY;
          const viewportHeight = window.innerHeight || 1000;
          const nextY = Math.min(currentY + viewportHeight, Math.max(0, currentHeight - viewportHeight));

          window.scrollTo(0, nextY);

          // Trigger lazy image loading if libraries rely on data-src/data-lazy-src.
          const images = Array.from(document.querySelectorAll("img"));
          for (const image of images) {
            const img = image as HTMLImageElement;
            if (!img.src) {
              const candidate = img.getAttribute("data-src") || img.getAttribute("data-lazy-src");
              if (candidate) {
                img.src = candidate;
              }
            }
            if (img.loading === "lazy") {
              img.loading = "eager";
            }
            img.decoding = "sync";
          }

          await sleep(settleDelay);

          const reachedBottom = window.scrollY + viewportHeight >= root.scrollHeight - 2;
          if (currentHeight === previousHeight) {
            sameHeightCount += 1;
          } else {
            sameHeightCount = 0;
          }
          previousHeight = currentHeight;

          if (reachedBottom && sameHeightCount >= 2) {
            break;
          }
        }
      }

      window.scrollTo(0, 0);
      await sleep(settleDelay);
    },
    { settleMs, maxPasses }
  );
}

export async function createCaptureRunner(
  request: CreateJobRequest,
  jobId: string
): Promise<CaptureRunner> {
  const browser = await chromium.launch({
    headless: true,
    args: (getEnv("PLAYWRIGHT_CHROMIUM_ARGS") || "").split(" ").filter(Boolean),
    timeout: getEnvInt("PLAYWRIGHT_LAUNCH_TIMEOUT_MS", 30000)
  });

  const contextCache = new Map<string, BrowserContext>();
  const navTimeout = getEnvInt("CAPTURE_NAV_TIMEOUT_MS", 90000);

  async function getContext(selection: PageSelection): Promise<BrowserContext> {
    const host = new URL(selection.url).host;
    const key = `${selection.locale}|${host}`;
    const cached = contextCache.get(key);
    if (cached) {
      return cached;
    }

    const context = await browser.newContext({
      extraHTTPHeaders:
        request.sendAcceptLanguage ?? true
          ? {
              "Accept-Language": selection.locale
            }
          : undefined
    });

    const cookie = getLocaleCookieConfig(request, selection);
    if (cookie) {
      await context.addCookies([cookie]);
    }

    contextCache.set(key, context);
    return context;
  }

  async function capture(selection: PageSelection): Promise<CaptureResult> {
    const context = await getContext(selection);
    const page = await context.newPage();
    try {
      await page.setViewportSize({ width: selection.breakpoint, height: 1000 });
      await page.goto(selection.url, {
        waitUntil: "networkidle",
        timeout: navTimeout
      });
      await page.waitForTimeout(250);
      await warmPageByScrolling(page);
      await page.waitForTimeout(Math.max(0, getEnvInt("CAPTURE_POST_SCROLL_WAIT_MS", 250)));

      const routeSlug = toRouteSlug(selection.url);
      const artifactPath = join(
        getBaseRunsDir(),
        jobId,
        selection.locale,
        routeSlug,
        `${selection.breakpoint}.png`
      );
      await mkdir(dirname(artifactPath), { recursive: true });
      await page.screenshot({
        path: artifactPath,
        fullPage: true
      });

      const size = await page.evaluate(() => ({
        width: Math.max(document.documentElement.scrollWidth, window.innerWidth),
        height: Math.max(document.documentElement.scrollHeight, window.innerHeight)
      }));

      return {
        artifactPath,
        width: size.width,
        height: size.height
      };
    } finally {
      await page.close();
    }
  }

  async function close(): Promise<void> {
    for (const context of contextCache.values()) {
      await context.close();
    }
    await browser.close();
  }

  return {
    capture,
    close
  };
}
