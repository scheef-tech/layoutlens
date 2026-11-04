import { afterEach, describe, expect, test } from "bun:test";
import { discoverSitemaps } from "../src/sitemap";

// fetch() is replaced by an in-memory site so discovery runs without network access.

const originalFetch = globalThis.fetch;
const requested: string[] = [];

function serveSite(files: Record<string, string>): void {
  requested.length = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    requested.push(url);
    const body = files[url];
    return body === undefined
      ? new Response("not found", { status: 404, statusText: "Not Found" })
      : new Response(body, { status: 200 });
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("discoverSitemaps", () => {
  test("never fetches non-http(s) sitemap locations", async () => {
    serveSite({
      "https://example.com/sitemap.xml": `<sitemapindex>
        <sitemap><loc>file:///etc/secrets.xml</loc></sitemap>
        <sitemap><loc>https://example.com/pages.xml</loc></sitemap>
      </sitemapindex>`,
      "https://example.com/pages.xml": `<urlset><url><loc>https://example.com/de/</loc></url></urlset>`
    });

    const result = await discoverSitemaps("https://example.com", 100, 10);

    expect(requested.some((url) => url.startsWith("file:"))).toBe(false);
    expect(result.sourceSitemaps).toEqual(["https://example.com/sitemap.xml", "https://example.com/pages.xml"]);
    expect(result.pageUrls).toEqual(["https://example.com/de/"]);
  });

  test("drops non-http(s) page URLs and hreflang alternates", async () => {
    serveSite({
      "https://example.com/sitemap.xml": `<urlset xmlns:xhtml="http://www.w3.org/1999/xhtml">
        <url>
          <loc>https://example.com/en/about</loc>
          <xhtml:link rel="alternate" hreflang="de" href="file:///proc/self/environ" />
          <xhtml:link rel="alternate" hreflang="fr" href="https://example.com/fr/about" />
        </url>
        <url><loc>file:///proc/self/environ</loc></url>
      </urlset>`
    });

    const result = await discoverSitemaps("https://example.com", 100, 10);

    expect(result.pageUrls).toEqual(["https://example.com/en/about"]);
    const urls = result.routeGroups.flatMap((group) => Object.values(group.locales));
    expect(urls.every((url) => url.startsWith("https://"))).toBe(true);
    expect(result.routeGroups[0]?.locales.fr).toBe("https://example.com/fr/about");
  });

  test("skips malformed .xml locations instead of aborting discovery", async () => {
    serveSite({
      "https://example.com/sitemap.xml": `<urlset>
        <url><loc>not a url.xml</loc></url>
        <url><loc>https://example.com/</loc></url>
      </urlset>`
    });

    const result = await discoverSitemaps("https://example.com", 100, 10);

    expect(result.pageUrls).toEqual(["https://example.com/"]);
  });

  test("does not report an already visited sitemap as a page", async () => {
    serveSite({
      "https://example.com/sitemap.xml": `<sitemapindex>
        <sitemap><loc>https://example.com/sitemap.xml</loc></sitemap>
        <sitemap><loc>https://example.com/pages.xml</loc></sitemap>
      </sitemapindex>`,
      "https://example.com/pages.xml": `<urlset><url><loc>https://example.com/a</loc></url></urlset>`
    });

    const result = await discoverSitemaps("https://example.com", 100, 10);

    expect(result.pageUrls).toEqual(["https://example.com/a"]);
  });
});
