import { gunzipSync } from "node:zlib";

// Sitemap discovery: robots.txt only tells us where sitemaps are (its rules are not applied),
// then sitemap.xml, sitemap index files, gzipped sitemaps, and their lastmod dates.

export interface SitemapEntry {
  url: string;
  lastmod?: string;
}

type Fetcher = (url: string) => Promise<{ status: number; body: Buffer; contentType: string }>;

function locs(xml: string, tag: "url" | "sitemap"): SitemapEntry[] {
  const entries: SitemapEntry[] = [];
  for (const block of xml.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "gi"))) {
    const body = block[1] ?? "";
    const loc = /<loc>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/loc>/i.exec(body)?.[1]?.trim();
    if (!loc) continue;
    const lastmod = /<lastmod>\s*([^<]+?)\s*<\/lastmod>/i.exec(body)?.[1];
    entries.push({ url: decodeXml(loc), ...(lastmod ? { lastmod } : {}) });
  }
  return entries;
}

function decodeXml(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function text(body: Buffer, url: string, contentType: string): string {
  const gzipped = body[0] === 0x1f && body[1] === 0x8b;
  if (gzipped || /\.gz$/i.test(new URL(url).pathname) || /gzip/i.test(contentType)) {
    try {
      return gunzipSync(body).toString("utf8");
    } catch {
      return body.toString("utf8");
    }
  }
  return body.toString("utf8");
}

/** Sitemap URLs named in robots.txt, plus the usual locations. */
export async function sitemapLocations(origin: string, fetcher: Fetcher): Promise<string[]> {
  const found = new Set<string>();
  try {
    const robots = await fetcher(`${origin}/robots.txt`);
    if (robots.status < 400)
      for (const match of robots.body.toString("utf8").matchAll(/^\s*sitemap:\s*(\S+)/gim))
        found.add(match[1] as string);
  } catch {
    // No robots.txt: fall back to the usual places.
  }
  found.add(`${origin}/sitemap.xml`);
  found.add(`${origin}/sitemap_index.xml`);
  return [...found];
}

async function readXml(url: string, fetcher: Fetcher): Promise<string | undefined> {
  try {
    const response = await fetcher(url);
    return response.status >= 400 ? undefined : text(response.body, url, response.contentType);
  } catch {
    return undefined;
  }
}

/** Plain-text sitemaps: one URL per line. */
function textUrls(xml: string): SitemapEntry[] {
  if (/<urlset|<sitemapindex/i.test(xml)) return [];
  return xml
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^https?:\/\//.test(line))
    .map((url) => ({ url }));
}

/** Every page URL in a site's sitemaps, following index files (up to `maxUrls`). */
export async function readSitemaps(
  origin: string,
  fetcher: Fetcher,
  maxUrls = 50_000,
): Promise<SitemapEntry[]> {
  const queue = await sitemapLocations(origin, fetcher);
  const seen = new Set<string>();
  const pages = new Map<string, SitemapEntry>();
  while (queue.length && pages.size < maxUrls && seen.size < 500) {
    const next = queue.shift() as string;
    if (seen.has(next)) continue;
    seen.add(next);
    const xml = await readXml(next, fetcher);
    if (xml === undefined) continue;
    for (const child of locs(xml, "sitemap")) queue.push(child.url);
    for (const page of [...locs(xml, "url"), ...textUrls(xml)])
      if (!pages.has(page.url)) pages.set(page.url, page);
  }
  return [...pages.values()].slice(0, maxUrls);
}
