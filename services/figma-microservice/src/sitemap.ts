const LOC_REGEX = /<loc>\s*([^<]+)\s*<\/loc>/gim;
const URL_BLOCK_REGEX = /<url\b[\s\S]*?<\/url>/gim;
const LINK_TAG_REGEX = /<xhtml:link\b([^>]*)>/gim;
const LOCALE_PATH_PATTERN = /^[a-z]{2}(?:-[a-z]{2})?$/i;

export type RouteGroup = {
  id: string;
  displayPath: string;
  locales: Record<string, string>;
};

type ParsedUrlEntry = {
  loc: string;
  alternates: Record<string, string>;
};

function decodeXmlEntities(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'");
}

function extractLocTags(xml: string): string[] {
  const results: string[] = [];
  for (const match of xml.matchAll(LOC_REGEX)) {
    const raw = match[1]?.trim();
    if (raw) {
      results.push(decodeXmlEntities(raw));
    }
  }
  return results;
}

function normalizeUrl(url: string): string {
  const normalized = new URL(url);
  normalized.hash = "";
  return normalized.toString();
}

function isSitemapXmlUrl(url: string): boolean {
  return /\.xml(\?.*)?$/i.test(url);
}

function buildInitialSitemapCandidates(baseUrl: string): string[] {
  const base = new URL(baseUrl);
  base.pathname = "/";
  base.search = "";
  base.hash = "";
  return [new URL("/sitemap.xml", base).toString(), new URL("/sitemap_index.xml", base).toString()];
}

async function fetchXml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      Accept: "application/xml,text/xml,text/plain;q=0.9,*/*;q=0.8"
    }
  });
  if (!res.ok) {
    throw new Error(`Failed sitemap fetch: ${res.status} ${res.statusText}`);
  }
  return await res.text();
}

function extractHreflangTags(xml: string): string[] {
  const results = new Set<string>();
  for (const entry of extractUrlEntries(xml)) {
    for (const locale of Object.keys(entry.alternates)) {
      results.add(locale);
    }
  }
  return [...results];
}

function parseLinkAttributes(attrs: string): { href?: string; hreflang?: string } {
  const href = attrs.match(/\bhref=["']([^"']+)["']/i)?.[1];
  const hreflangRaw = attrs.match(/\bhreflang=["']([^"']+)["']/i)?.[1];
  const hreflang = hreflangRaw?.toLowerCase();
  return { href: href ? decodeXmlEntities(href) : undefined, hreflang };
}

function extractUrlEntries(xml: string): ParsedUrlEntry[] {
  const entries: ParsedUrlEntry[] = [];
  for (const blockMatch of xml.matchAll(URL_BLOCK_REGEX)) {
    const block = blockMatch[0];
    const loc = extractLocTags(block)[0];
    if (!loc) {
      continue;
    }
    const alternates: Record<string, string> = {};
    for (const linkMatch of block.matchAll(LINK_TAG_REGEX)) {
      const attrs = parseLinkAttributes(linkMatch[1] || "");
      if (!attrs.href || !attrs.hreflang || attrs.hreflang === "x-default") {
        continue;
      }
      alternates[attrs.hreflang] = attrs.href;
    }
    entries.push({ loc, alternates });
  }
  return entries;
}

function inferLocaleFromUrl(url: string): string | undefined {
  try {
    const seg = new URL(url).pathname.split("/").filter(Boolean)[0];
    return seg && LOCALE_PATH_PATTERN.test(seg) ? seg.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

function normalizedPathForGrouping(url: string, locales: Set<string>): string {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const first = segments[0]?.toLowerCase();
    const withoutLocale = first && locales.has(first) ? segments.slice(1) : segments;
    return "/" + withoutLocale.join("/");
  } catch {
    return url;
  }
}

function buildRouteGroups(
  entries: ParsedUrlEntry[],
  knownLocales: Set<string>,
  defaultLocale?: string
): RouteGroup[] {
  const groups = new Map<string, RouteGroup>();

  for (const entry of entries) {
    const localeUrls: Record<string, string> = { ...entry.alternates };
    const inferredFromLoc = inferLocaleFromUrl(entry.loc);
    if (inferredFromLoc) {
      localeUrls[inferredFromLoc] = entry.loc;
      knownLocales.add(inferredFromLoc);
    } else if (defaultLocale) {
      localeUrls[defaultLocale.toLowerCase()] = entry.loc;
      knownLocales.add(defaultLocale.toLowerCase());
    }

    const canonicalSource =
      localeUrls.en || localeUrls["en-us"] || localeUrls["en-gb"] || entry.loc;
    const normalizedPath = normalizedPathForGrouping(canonicalSource, knownLocales) || "/";
    const id = normalizedPath === "/" ? "home" : normalizedPath.replace(/^\/+/, "");
    const displayPath = normalizedPath === "/" ? "/" : normalizedPath;

    const existing = groups.get(id);
    if (!existing) {
      groups.set(id, {
        id,
        displayPath,
        locales: { ...localeUrls }
      });
      continue;
    }

    for (const [locale, url] of Object.entries(localeUrls)) {
      if (!existing.locales[locale]) {
        existing.locales[locale] = url;
      }
    }
  }

  return [...groups.values()].sort((a, b) => a.displayPath.localeCompare(b.displayPath));
}

export async function discoverSitemaps(
  baseUrl: string,
  maxUrls = 500,
  maxSitemaps = 20,
  options?: { defaultLocale?: string }
): Promise<{ sourceSitemaps: string[]; pageUrls: string[]; hreflangs: string[]; routeGroups: RouteGroup[] }> {
  const queue = buildInitialSitemapCandidates(baseUrl);
  const visited = new Set<string>();
  const sourceSitemaps: string[] = [];
  const pageUrls: string[] = [];
  const pageSet = new Set<string>();
  const hreflangs = new Set<string>();
  const allEntries: ParsedUrlEntry[] = [];

  while (queue.length > 0 && sourceSitemaps.length < maxSitemaps && pageUrls.length < maxUrls) {
    const next = normalizeUrl(queue.shift()!);
    if (visited.has(next)) {
      continue;
    }
    visited.add(next);

    let xml: string;
    try {
      xml = await fetchXml(next);
    } catch {
      continue;
    }

    sourceSitemaps.push(next);
    const urlEntries = extractUrlEntries(xml);
    allEntries.push(...urlEntries);
    for (const hreflang of extractHreflangTags(xml)) {
      hreflangs.add(hreflang);
    }

    const locs = extractLocTags(xml);
    for (const loc of locs) {
      if (isSitemapXmlUrl(loc) && !visited.has(normalizeUrl(loc))) {
        queue.push(loc);
        continue;
      }
      if (!pageSet.has(loc)) {
        pageSet.add(loc);
        pageUrls.push(loc);
      }
      if (pageUrls.length >= maxUrls) {
        break;
      }
    }
  }

  const localeSet = new Set<string>([...hreflangs].map((v) => v.toLowerCase()));
  const routeGroups = buildRouteGroups(allEntries, localeSet, options?.defaultLocale);

  return {
    sourceSitemaps,
    pageUrls,
    hreflangs: [...localeSet],
    routeGroups
  };
}

export function discoverLocalesFromUrls(urls: string[], options?: { defaultLocale?: string }): string[] {
  const locales = new Set<string>();
  let foundNonPrefixedPath = false;
  for (const pageUrl of urls) {
    try {
      const pathSegments = new URL(pageUrl).pathname.split("/").filter(Boolean);
      const maybeLocale = pathSegments[0]?.toLowerCase();
      if (maybeLocale && LOCALE_PATH_PATTERN.test(maybeLocale)) {
        locales.add(maybeLocale);
      } else {
        foundNonPrefixedPath = true;
      }
    } catch {
      // Ignore malformed URLs discovered in a sitemap.
    }
  }
  const defaultLocale = options?.defaultLocale?.trim().toLowerCase();
  if (defaultLocale && foundNonPrefixedPath) {
    locales.add(defaultLocale);
  }
  return [...locales];
}
