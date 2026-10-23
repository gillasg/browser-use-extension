// The mapped-site API client is supplied by the host. browser-crawl no longer imports
// site-to-api directly: a host that has it (the Browser Use Extension, Aeon) installs an adapter
// once with `useSiteApi()`, and every crawler in the process can then read mapped sites through
// their API. Standalone browser-crawl simply fetches the page normally.

export interface MappedPage {
  id: string;
  origin: string;
  path: string;
  extractor?: unknown;
}

export interface MappedModel {
  pages?: MappedPage[];
}

export interface MappedApi {
  fetchPage(pageId: string, params?: Record<string, string>): Promise<unknown>;
  paginate(
    operation: string,
    params?: Record<string, unknown>,
    options?: { maxItems?: number },
  ): AsyncIterable<unknown>;
}

export interface SiteApiAdapter {
  /** `https://www.shop.example/x` -> `shop.example`. */
  siteName(url: string): string;
  loadModel(site: string): Promise<MappedModel | undefined>;
  siteApi(site: string, options?: { transport?: "direct" }): Promise<MappedApi>;
  /** Whether an error means "no browser is connected" (mapped pages can still be read directly). */
  isBrowserNotConnected(error: unknown): boolean;
}

let current: SiteApiAdapter | undefined;

/** Installs (or clears, with `undefined`) the host's site-to-api adapter. */
export function useSiteApi(adapter: SiteApiAdapter | undefined): void {
  current = adapter;
}

export function siteApiAdapter(): SiteApiAdapter | undefined {
  return current;
}
