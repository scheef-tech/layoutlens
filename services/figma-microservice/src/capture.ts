import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { chromium } from "playwright";
import type { CreateJobRequest, PageSelection } from "./types";

type CaptureResult = {
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
  return process.env.RUNS_DIR?.trim() || "runs";
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
  const envName = process.env.LOCALE_COOKIE_NAME?.trim();
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
  const browser = await chromium.launch({
    headless: true,
    args: process.env.PLAYWRIGHT_CHROMIUM_ARGS?.split(" ").filter(Boolean) || []
  });

  const context = await browser.newContext({
    extraHTTPHeaders:
      request.sendAcceptLanguage ?? true
        ? {
            "Accept-Language": selection.locale
          }
        : undefined
  });

  try {
    const cookie = getLocaleCookieConfig(request, selection);
    if (cookie) {
      await context.addCookies([cookie]);
    }

    const page = await context.newPage();
    await page.setViewportSize({ width: selection.breakpoint, height: 1000 });
    await page.goto(selection.url, {
      waitUntil: "networkidle",
      timeout: 90000
    });
    await page.waitForTimeout(300);

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
    await context.close();
    await browser.close();
  }
}
