import type { ScrapeOptions } from "../types.js";
import { ApiFetcher } from "./api.js";
import { BrowserFetcher } from "./browser.js";
import { StaticFetcher } from "./static.js";
import type { Fetched, Fetcher, Validators } from "./types.js";
import { botCheck, isDnsFailure, isNetworkRefusal } from "../challenge.js";

// Mixed fetching: a mapped API when there is one, plain HTTP next, and the browser only when the
// page needs it (rendered by JavaScript, behind a login, a bot wall, or browser-only options).

const BROWSER_ONLY: (keyof ScrapeOptions)[] = [
  "actions",
  "scroll",
  "expand",
  "waitFor",
  "location",
  "mobile",
  "blockResources",
];

const BROWSER_FORMATS = ["screenshot", "pdf", "mhtml"];

/** Why a plain HTTP answer is not good enough, or undefined when it is. */
export function needsBrowser(fetched: Fetched): string | undefined {
  if ([401, 403, 407, 503].includes(fetched.status)) return `HTTP ${fetched.status}`;
  if (!/html/i.test(fetched.contentType)) return undefined;
  const html = fetched.body.toString("utf8");
  const vendor = botCheck(fetched.headers, html);
  if (vendor) return "bot check";
  const text = html
    .replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const scripts = (html.match(/<script\b/gi) ?? []).length;
  if (text.length < 200 && scripts > 0) return "rendered by JavaScript";
  if (/<noscript>[^<]*(enable|requires?) javascript/i.test(html) && text.length < 1500)
    return "needs JavaScript";
  if (/<div id="(root|app|__next|___gatsby)"><\/div>/i.test(html)) return "empty app shell";
  return undefined;
}

export interface AutoOptions {
  workers?: number;
  /** Fetchers to use instead of the defaults (tests, other runtimes). */
  fetchers?: { static?: Fetcher; browser?: Fetcher; api?: ApiFetcher };
}

export class AutoFetcher {
  readonly static: Fetcher;
  readonly browser: Fetcher;
  readonly api: ApiFetcher;
  /** Hosts where plain HTTP was not enough: go straight to the browser next time. */
  private readonly browserHosts = new Set<string>();

  constructor(options: AutoOptions = {}) {
    this.static = options.fetchers?.static ?? new StaticFetcher();
    this.browser = options.fetchers?.browser ?? new BrowserFetcher(options.workers ?? 3);
    this.api = options.fetchers?.api ?? new ApiFetcher();
  }

  private async fromApi(
    url: string,
    options: ScrapeOptions & { useApis?: boolean },
  ): Promise<Fetched | undefined> {
    if (options.render === "api") return this.api.fetch(url, options);
    if (options.useApis === false || options.render) return undefined;
    if (!(await this.api.endpoint(url).catch(() => undefined))) return undefined;
    return this.api.fetch(url, options).catch(() => undefined);
  }

  /** Whether this fetch should go to the browser without trying plain HTTP first. */
  private browserFirst(url: string, options: ScrapeOptions): boolean {
    if (options.render === "browser") return true;
    if (options.render === "static") return false;
    const wantsBrowser =
      BROWSER_ONLY.some((key) => options[key] !== undefined) ||
      (options.formats ?? []).some((format) => BROWSER_FORMATS.includes(format));
    return wantsBrowser || this.browserHosts.has(new URL(url).host);
  }

  async fetch(
    url: string,
    options: ScrapeOptions & { useApis?: boolean },
    validators?: Validators,
  ): Promise<Fetched> {
    const fromApi = await this.fromApi(url, options);
    if (fromApi) return fromApi;
    if (this.browserFirst(url, options)) return this.browser.fetch(url, options);
    let fetched: Fetched;
    try {
      fetched = await this.static.fetch(url, options, validators);
    } catch (error) {
      // Refused below HTTP (reset, TLS, timeout): some sites drop connections that do not come
      // from a real browser. Chrome gets in where plain HTTP cannot, so that host uses it from now.
      if (options.render === "static" || isDnsFailure(error) || !isNetworkRefusal(error))
        throw error;
      this.browserHosts.add(new URL(url).host);
      return this.browser.fetch(url, options);
    }
    if (options.render === "static" || fetched.notModified) return fetched;
    const reason = needsBrowser(fetched);
    if (!reason) return fetched;
    // A whole site that needs JavaScript or checks for bots goes to the browser from now on;
    // one page behind a login only needs it for that page.
    if (!/^HTTP 40[137]$/.test(reason)) this.browserHosts.add(new URL(url).host);
    try {
      return await this.browser.fetch(url, options);
    } catch {
      return fetched;
    }
  }

  async close(): Promise<void> {
    await this.browser.close?.();
  }
}
