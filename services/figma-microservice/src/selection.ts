import type { Breakpoint, PageSelection } from "./types";

export function toPageSelections(
  pages: string[],
  locales: string[],
  breakpoints: Breakpoint[]
): PageSelection[] {
  const normalizedLocales = locales.length > 0 ? locales : ["default"];
  const normalizedBreakpoints = breakpoints.length > 0 ? breakpoints : [1440];
  const dedupedPages = [...new Set(pages)];
  const selections: PageSelection[] = [];

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

function toRouteKey(pageUrl: string): string {
  try {
    const url = new URL(pageUrl);
    const path = url.pathname === "/" ? "home" : url.pathname.replaceAll("/", "_").replace(/^_+/, "");
    return `${url.hostname}${path ? `_${path}` : ""}`.toLowerCase();
  } catch {
    return pageUrl.replaceAll(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
  }
}
