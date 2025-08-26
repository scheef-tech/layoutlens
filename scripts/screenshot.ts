import { chromium, firefox, webkit, type Browser } from "playwright";
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

  for (const locale of cfg.locales) {
    const headers = cfg.behavior.sendAcceptLanguage
      ? { "Accept-Language": locale }
      : undefined;
    const context = await browser.newContext({ extraHTTPHeaders: headers });

    const domain =
      cfg.cookie.domain || new URL(cfg.url).hostname || "localhost";
    const path = cfg.cookie.path ?? "/";
    await context.addCookies([
      {
        name: cfg.cookie.name,
        value: locale,
        domain,
        path,
        sameSite: cfg.cookie.sameSite as any,
        secure: Boolean(cfg.cookie.secure),
        httpOnly: Boolean(cfg.cookie.httpOnly),
      },
    ]);

    const page = await context.newPage();
    for (const bp of cfg.breakpoints) {
      const url = buildUrl(cfg.url, cfg.behavior, locale);
      await page.setViewportSize({ width: bp, height: 1000 });
      await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
      const dir = join(cfg.outDir, locale);
      mkdirSync(dir, { recursive: true });
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
    }
    await context.close();
  }

  writeFileSync(
    join(cfg.outDir, "manifest.json"),
    JSON.stringify(manifest, null, 2)
  );
  await browser.close();
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
