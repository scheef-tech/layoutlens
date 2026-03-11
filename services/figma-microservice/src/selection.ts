import type { Breakpoint, PageSelection } from "./types";

export function toPageSelections(
  pages: string[],
  locales: string[],
  breakpoints: Breakpoint[],
  targets?: Array<{ url: string; locale: string; routeKey?: string }>
): PageSelection[] {
  const normalizedBreakpoints = breakpoints.length > 0 ? breakpoints : [1440];
  const selections: PageSelection[] = [];
  const targetMode = Array.isArray(targets) && targets.length > 0;

  if (targetMode) {
    const dedupedTargets = dedupeTargets(targets || []);
    for (const target of dedupedTargets) {
      for (const breakpoint of normalizedBreakpoints) {
        selections.push({
          url: target.url,
          routeKey: target.routeKey || toRouteKey(target.url),
          locale: target.locale,
          breakpoint
        });
      }
    }
    return selections;
  }

  const normalizedLocales = locales.length > 0 ? locales : ["default"];
  const dedupedPages = [...new Set(pages)];
  for (const pageUrl of dedupedPages) {
    const routeKey = toRouteKey(pageUrl);
    for (const locale of normalizedLocales) {
      for (const breakpoint of normalizedBreakpoints) {
        selections.push({
          url: pageUrl,
          routeKey,
          locale,
          breakpoint
        });
      }
    }
  }

  return selections;
}

function dedupeTargets(
  targets: Array<{ url: string; locale: string; routeKey?: string }>
): Array<{ url: string; locale: string; routeKey?: string }> {
  const seen = new Set<string>();
  const output: Array<{ url: string; locale: string; routeKey?: string }> = [];
  for (const target of targets) {
    const key = `${target.url}::${target.locale}::${target.routeKey || ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(target);
  }
  return output;
}

function toRouteKey(pageUrl: string): string {
  try {
    const url = new URL(pageUrl);
    const path = url.pathname === "/" ? "home" : url.pathname.replaceAll("/", "_").replace(/^_+/, "");
    return `${url.hostname}${path ? `_${path}` : ""}`.toLowerCase();
  } catch {
    return pageUrl.replaceAll(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
  }
}
