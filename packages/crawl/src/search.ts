import { sharedBridge, type Bridge } from "./bridge.js";
import { AutoFetcher } from "./fetch/auto.js";
import { scrape } from "./scrape.js";
import type { PageResult, ScrapeOptions } from "./types.js";

// Search, then read the results: a real Google search in the user's browser (their region,
// language and personalisation), then each result fetched in the chosen formats.

export interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
}

export async function search(
  query: string,
  options: { limit?: number; bridge?: () => Promise<Bridge> } = {},
): Promise<SearchResult[]> {
  const bridge = await (options.bridge ?? sharedBridge)();
  const results = (await bridge.run(
    `await google.search(${JSON.stringify(query)}, { limit: ${options.limit ?? 10} })`,
    { session: "browser-crawl-search" },
  )) as SearchResult[];
  return (results ?? []).map((item) => ({
    title: item.title,
    url: item.url,
    ...(item.snippet ? { snippet: item.snippet } : {}),
  }));
}

/** Searches and scrapes the top results. */
export async function searchAndScrape(
  query: string,
  options: ScrapeOptions & {
    limit?: number;
    bridge?: () => Promise<Bridge>;
    fetcher?: AutoFetcher;
  } = {},
): Promise<(SearchResult & { page?: PageResult })[]> {
  const found = await search(query, options);
  const fetcher = options.fetcher ?? new AutoFetcher();
  try {
    return await Promise.all(
      found.map(async (result) => {
        const page = await scrape(
          result.url,
          { ...options, query: options.query ?? query },
          { fetcher },
        ).catch(() => undefined);
        return page ? { ...result, page } : result;
      }),
    );
  } finally {
    if (!options.fetcher) await fetcher.close();
  }
}
