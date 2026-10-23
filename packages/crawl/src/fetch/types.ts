import type { ScrapeOptions } from "../types.js";

// What every fetcher returns: the response, plus what only a browser can see.

export interface Fetched {
  url: string;
  finalUrl: string;
  status: number;
  headers: Record<string, string>;
  contentType: string;
  /** The body as sent (files are kept as bytes). */
  body: Buffer;
  fetchedBy: "static" | "browser" | "api";
  /** The rendered page's HTML, when a browser fetched it. */
  html?: string;
  /** Data the page carried or loaded: embedded state and the JSON its own requests returned. */
  pageData?: Record<string, unknown>;
  screenshot?: string;
  pdf?: string;
  mhtml?: string;
  /** The server said the cached copy is still current (304). */
  notModified?: boolean;
  /** Structured data from a mapped API (site-to-api), instead of a page. */
  json?: unknown;
}

export interface Validators {
  etag?: string;
  lastModified?: string;
}

export interface Fetcher {
  readonly name: "static" | "browser" | "api";
  fetch(url: string, options: ScrapeOptions, validators?: Validators): Promise<Fetched>;
  close?(): Promise<void>;
}

export class FetchError extends Error {
  constructor(
    message: string,
    public readonly status = 0,
    public readonly retryAfter?: string,
  ) {
    super(message);
    this.name = "FetchError";
  }
}
