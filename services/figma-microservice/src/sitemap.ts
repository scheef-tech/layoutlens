const LOC_REGEX = /<loc>\s*([^<]+)\s*<\/loc>/gim;

const LOCALE_PATH_PATTERN = /^[a-z]{2}(?:-[A-Z]{2})?$/;

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
    if (!raw) {
      continue;
    }
    results.push(decodeXmlEntities(raw));
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
  return [
    new URL("/sitemap.xml", base).toString(),
    new URL("/sitemap_index.xml", base).toString()
  ];
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

export async function discoverSitemaps(
  baseUrl: string,
  maxUrls = 500,
  maxSitemaps = 20
): Promise<{ sourceSitemaps: string[]; pageUrls: string[] }> {
  const queue = buildInitialSitemapCandidates(baseUrl);
  const visited = new Set<string>();
  const sourceSitemaps: string[] = [];
  const pageUrls: string[] = [];
  const pageSet = new Set<string>();

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

  return { sourceSitemaps, pageUrls };
}

export function discoverLocalesFromUrls(urls: string[]): string[] {
  const locales = new Set<string>();
  for (const pageUrl of urls) {
    try {
      const pathSegments = new URL(pageUrl).pathname.split("/").filter(Boolean);
      const maybeLocale = pathSegments[0];
      if (maybeLocale && LOCALE_PATH_PATTERN.test(maybeLocale)) {
        locales.add(maybeLocale);
      }
    } catch {
      // Ignore malformed URLs discovered in a sitemap.
    }
  }
  return [...locales];
}
