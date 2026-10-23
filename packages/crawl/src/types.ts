// Options and results shared by scrape, map, crawl, sync and search.

export type Format =
  | "markdown"
  | "mainMarkdown"
  | "fitMarkdown"
  | "html"
  | "cleanedHtml"
  | "rawHtml"
  | "text"
  | "links"
  | "images"
  | "metadata"
  | "tables"
  | "pageData"
  | "product"
  | "screenshot"
  | "pdf"
  | "mhtml"
  | "json"
  | "summary";

export type Action =
  | { type: "click"; selector: string }
  | { type: "write"; selector: string; text: string }
  | { type: "press"; key: string }
  | { type: "scroll"; direction?: "up" | "down"; amount?: number }
  | { type: "wait"; ms?: number; selector?: string }
  | { type: "js"; code: string }
  | { type: "screenshot"; fullPage?: boolean };

/** How a page is fetched. `auto` tries plain HTTP first and switches to the browser when needed. */
export type Render = "auto" | "static" | "browser" | "api";

export interface FetchOptions {
  render?: Render;
  /** Browser: wait for this load state. Default `load`. */
  waitUntil?: "load" | "domcontentloaded" | "networkidle";
  /** Browser: wait until this CSS selector is on the page. */
  waitFor?: string;
  timeoutMs?: number;
  /** Browser: resource types not to load. */
  blockResources?: ("image" | "media" | "font" | "stylesheet")[];
  headers?: Record<string, string>;
  /** A Cookie header, or name → value. Static fetches use it; the browser has its own. */
  cookies?: string | Record<string, string>;
  auth?: { username: string; password: string };
  /** Plain HTTP fetches go through this proxy (http://user:pass@host:port), for example to read a
   *  site as seen from another country. Default: the BROWSER_CRAWL_PROXY environment variable. */
  proxy?: string;
  /** Browser: language (Accept-Language and navigator) and location. */
  language?: string;
  location?: { latitude: number; longitude: number };
  mobile?: boolean;
  actions?: Action[];
  /** Browser: scroll until no new content appears (`infinite`), or this many times. */
  scroll?: "infinite" | number;
  /** Browser: click "show more", "read more" and similar expanders first. */
  expand?: boolean;
  /** Use a cached copy younger than this. */
  maxAge?: number;
  /** Skip pages not modified since this date (ISO), using sitemap lastmod and Last-Modified. */
  modifiedSince?: string;
  /** Hand the page to the user when it asks them to sign in or verify. Default true in the browser. */
  handoff?: boolean;
  /** How long a page waits for the user before it is kept as is. Default 5 minutes. */
  handoffTimeoutMs?: number;
}

export interface CssField {
  name: string;
  selector: string;
  type?: "text" | "html" | "attr" | "number" | "list" | "nested";
  attr?: string;
  fields?: CssField[];
}

export interface CssSchema {
  baseSelector?: string;
  fields: CssField[];
}

export interface ExtractOptions {
  /** JSON Schema for the model to fill. */
  schema?: Record<string, unknown>;
  prompt?: string;
  /** A CSS schema: no model needed. */
  css?: CssSchema;
}

export interface ScrapeOptions extends FetchOptions {
  formats?: Format[];
  /** Markdown of the main content only (default true for `markdown`). */
  onlyMainContent?: boolean;
  includeTags?: string[];
  excludeTags?: string[];
  /** What the crawl is about: ranks links, filters `fitMarkdown`, stops adaptive crawls. */
  query?: string;
  extract?: ExtractOptions;
}

export interface CrawlOptions extends ScrapeOptions {
  url?: string;
  /** Extra start URLs. */
  seeds?: string[];
  /** Where URLs come from. Default `all` (sitemaps and links). */
  source?: "all" | "sitemaps" | "links";
  maxDepth?: number;
  /** Most pages to fetch. Default 100. */
  limit?: number;
  /** Globs (`/blog/**`) or regexes (`re:^/docs/`), matched on the path unless matchFullUrl. */
  include?: string[];
  exclude?: string[];
  matchFullUrl?: boolean;
  subdomains?: boolean;
  /** Follow links to other sites. */
  external?: boolean;
  /** Ignore all query parameters (true) or these ones when deduplicating. */
  ignoreQuery?: boolean | string[];
  strategy?: "bfs" | "dfs" | "best";
  /** Stop when the query is well covered: no better page in the last `window` pages. */
  adaptive?: boolean | { window?: number; threshold?: number };
  concurrency?: number;
  /** Least time between two requests to one host. */
  delayMs?: number;
  /** Slow down when the site does, speed up when it is fast. Default true. */
  autoThrottle?: boolean;
  retries?: number;
  /** Keep the crawl's state here, so it can be paused and resumed. */
  stateDir?: string;
  webhook?: { url: string; secret?: string; events?: CrawlEventType[] };
  /** Fetch pages of sites mapped with site-to-api through their API (default true). */
  useApis?: boolean;
  /** Crawl a mapped API instead of pages: every item of a paginated operation. */
  api?: { site: string; operation: string; params?: Record<string, unknown>; maxItems?: number };
}

export type PageStatus = "queued" | "completed" | "skipped" | "errored" | "cancelled";

export interface PageResult {
  url: string;
  finalUrl: string;
  status: number;
  depth: number;
  fetchedBy: "static" | "browser" | "api" | "cache";
  fetchedAt: string;
  contentType?: string;
  title?: string;
  markdown?: string;
  mainMarkdown?: string;
  fitMarkdown?: string;
  html?: string;
  cleanedHtml?: string;
  rawHtml?: string;
  text?: string;
  links?: { url: string; text: string; internal: boolean }[];
  images?: { url: string; alt: string }[];
  metadata?: Record<string, unknown>;
  tables?: Record<string, string>[][];
  pageData?: Record<string, unknown>;
  product?: Record<string, unknown>;
  screenshot?: string;
  pdf?: string;
  mhtml?: string;
  json?: unknown;
  summary?: string;
  /** Relevance to the query, 0 to 1. */
  score?: number;
  contentHash?: string;
  change?: { status: "new" | "same" | "changed"; diff?: string };
  error?: string;
}

export type CrawlEventType = "started" | "page" | "completed" | "failed" | "paused" | "cancelled";

export interface CrawlEvent {
  type: CrawlEventType;
  jobId: string;
  at: string;
  page?: PageResult;
  error?: string;
  stats?: CrawlStats;
}

export interface CrawlStats {
  queued: number;
  completed: number;
  skipped: number;
  errored: number;
  cancelled: number;
}

export type JobState = "running" | "paused" | "completed" | "failed" | "cancelled";
