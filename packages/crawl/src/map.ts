import { links, parse } from "./content/html.js";
import { rawFetcher, StaticFetcher } from "./fetch/static.js";
import { linkScore } from "./relevance.js";
import { readSitemaps } from "./sitemap.js";
import type { CrawlOptions } from "./types.js";
import { isFetchable, normalizeUrl, Scope } from "./url.js";

// A fast list of a site's URLs: its sitemaps plus the links on its first pages, without
// fetching page content. Optionally ranked by a search phrase.

export interface MapOptions extends Pick<
  CrawlOptions,
  "include" | "exclude" | "matchFullUrl" | "subdomains" | "ignoreQuery" | "source"
> {
  limit?: number;
  /** Rank URLs by this phrase and drop ones that do not match it. */
  search?: string;
  /** How many link levels to follow from the start page when sitemaps are thin. Default 1. */
  depth?: number;
}

export interface MappedUrl {
  url: string;
  lastmod?: string;
  title?: string;
}

/** Same-site links on one page that are new. */
async function newLinks(
  page: string,
  scope: Scope,
  fetcher: StaticFetcher,
  found: Map<string, MappedUrl>,
): Promise<string[]> {
  const response = await fetcher.fetch(page, {}).catch(() => undefined);
  if (!response || response.status >= 400 || !/html/i.test(response.contentType)) return [];
  const next: string[] = [];
  for (const link of links(parse(response.body.toString("utf8")), response.finalUrl)) {
    const url = normalizeUrl(link.url);
    if (found.has(url) || scope.reject(url) || !isFetchable(url)) continue;
    found.set(url, { url, ...(link.text ? { title: link.text } : {}) });
    next.push(url);
  }
  return next;
}

async function linkLevels(
  start: string,
  scope: Scope,
  fetcher: StaticFetcher,
  depth: number,
  limit: number,
  found: Map<string, MappedUrl>,
): Promise<void> {
  let level = [start];
  for (let d = 0; d < depth && level.length && found.size < limit; d++) {
    const next: string[] = [];
    for (const page of level.slice(0, 25))
      next.push(...(await newLinks(page, scope, fetcher, found)));
    level = next;
  }
}

export async function mapSite(
  start: string,
  options: MapOptions = {},
  fetcher = new StaticFetcher(),
): Promise<MappedUrl[]> {
  const limit = options.limit ?? 5000;
  const scope = new Scope([start], options);
  const found = new Map<string, MappedUrl>();
  if (options.source !== "links")
    for (const entry of await readSitemaps(new URL(start).origin, rawFetcher(fetcher), limit).catch(
      () => [],
    )) {
      const url = normalizeUrl(entry.url, options.ignoreQuery);
      if (!scope.reject(url))
        found.set(url, { url, ...(entry.lastmod ? { lastmod: entry.lastmod } : {}) });
    }
  if (options.source !== "sitemaps")
    await linkLevels(normalizeUrl(start), scope, fetcher, options.depth ?? 1, limit, found);
  let urls = [...found.values()];
  if (options.search) {
    const search = options.search;
    urls = urls
      .map((item) => ({ item, score: linkScore(item.url, item.title ?? "", search) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .map(({ item }) => item);
  }
  return urls.slice(0, limit);
}
