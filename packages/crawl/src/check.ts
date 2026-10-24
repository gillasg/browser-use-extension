import { sharedBridge } from "./bridge.js";
import { botCheck, isDnsFailure, isNetworkRefusal } from "./challenge.js";

// Which of many sites load, with evidence for every verdict. Plain HTTP answers first (fast,
// many at once); anything it cannot settle (a refused connection, a bot check, 401/403/429/503, a
// timeout) is asked again through the user's Chrome, whose network stack, IP and cookies are what
// the user actually gets. A few plain-HTTP successes are re-checked in Chrome too, and the
// disagreement is reported, so a wrong rule shows up before anyone trusts the numbers.

export type SiteVerdict =
  | "ok"
  | "js-shell"
  | "challenge"
  | "login"
  | "blocked"
  | "rate-limited"
  | "server-error"
  | "not-found"
  | "parked"
  | "dead"
  | "refused"
  | "unchecked";

export interface SiteCheck {
  url: string;
  host: string;
  verdict: SiteVerdict;
  via: "http" | "chrome";
  status?: number;
  finalUrl?: string;
  title?: string;
  /** Why: the status, the bot-check vendor, the network error, or what made it parked. */
  reason?: string;
}

export interface CheckOptions {
  concurrency?: number;
  timeoutMs?: number;
  /** Plain-HTTP successes re-checked in Chrome (default 5). */
  spotChecks?: number;
  /** Use the user's browser for what plain HTTP cannot settle (default true). */
  browser?: boolean;
  onProgress?(done: number, total: number): void;
}

export interface CheckReport {
  results: SiteCheck[];
  counts: Partial<Record<SiteVerdict, number>>;
  spotCheck: { checked: number; disagreed: string[] };
  browserUsed: boolean;
}

interface Answer {
  status: number;
  finalUrl: string;
  headers: Record<string, string>;
  html: string;
}

const HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
};
const BODY_LIMIT = 60_000;
const SETTLED: ReadonlySet<SiteVerdict> = new Set([
  "ok",
  "js-shell",
  "not-found",
  "parked",
  "dead",
  "server-error",
]);

export async function checkSites(
  inputs: readonly string[],
  options: CheckOptions = {},
): Promise<CheckReport> {
  const urls = [...new Set(inputs.map(siteUrl).filter((u): u is string => Boolean(u)))];
  let done = 0;
  const results = await mapLimit(urls, options.concurrency ?? 40, async (url) => {
    const result = await checkOverHttp(url, options.timeoutMs ?? 8000);
    options.onProgress?.(++done, urls.length);
    return result;
  });
  const browserUsed = options.browser !== false && (await browserAvailable());
  const spotCheck = { checked: 0, disagreed: [] as string[] };
  if (browserUsed) await settleInChrome(results, options, spotCheck);
  else
    for (const result of results)
      if (!SETTLED.has(result.verdict)) {
        result.reason = `${result.reason ?? result.verdict}; not checked in Chrome (no browser)`;
      }
  return { results, counts: countVerdicts(results), spotCheck, browserUsed };
}

/** "example.com", "https://example.com/x" → "https://example.com/x"; junk → undefined. */
export function siteUrl(input: string): string | undefined {
  const text = input.trim();
  if (!text) return undefined;
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    return url.hostname.includes(".") ? url.href : undefined;
  } catch {
    return undefined;
  }
}

async function checkOverHttp(url: string, timeoutMs: number): Promise<SiteCheck> {
  const host = new URL(url).hostname;
  try {
    const response = await fetch(url, {
      headers: HEADERS,
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const html = (await response.text()).slice(0, BODY_LIMIT);
    const answer = {
      status: response.status,
      finalUrl: response.url || url,
      headers: Object.fromEntries(response.headers),
      html,
    };
    return { url, host, via: "http", ...judge(answer) };
  } catch (error) {
    if (isDnsFailure(error))
      return { url, host, via: "http", verdict: "dead", reason: "the name does not resolve" };
    const reason = isNetworkRefusal(error) ? networkReason(error) : String(error);
    return { url, host, via: "http", verdict: "refused", reason };
  }
}

function networkReason(error: unknown): string {
  const code = (error as { cause?: { code?: string } })?.cause?.code;
  return `plain HTTP failed (${code ?? String((error as Error)?.message ?? error)})`;
}

/** The verdict for one answer, with its evidence. */
export function judge(answer: Answer): Omit<SiteCheck, "url" | "host" | "via"> {
  const title = titleOf(answer.html);
  const base = { status: answer.status, finalUrl: answer.finalUrl, ...(title ? { title } : {}) };
  const vendor = botCheck(answer.headers, answer.html);
  if (vendor) return { ...base, verdict: "challenge", reason: `${vendor} bot check` };
  const byStatus = statusVerdict(answer.status);
  if (byStatus) return { ...base, verdict: byStatus, reason: `HTTP ${answer.status}` };
  if (isParked(answer.html, title))
    return { ...base, verdict: "parked", reason: "a parked or for-sale domain page" };
  if (readableText(answer.html).length < 200)
    return { ...base, verdict: "js-shell", reason: "little text until JavaScript runs" };
  return { ...base, verdict: "ok" };
}

function statusVerdict(status: number): SiteVerdict | undefined {
  if (status === 401 || status === 407) return "login";
  if (status === 403 || status === 451) return "blocked";
  if (status === 429) return "rate-limited";
  if (status === 404 || status === 410) return "not-found";
  if (status >= 500) return "server-error";
  if (status >= 400) return "blocked";
  return undefined;
}

function titleOf(html: string): string | undefined {
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, " ").trim();
  return title || undefined;
}

function readableText(html: string): string {
  return html
    .replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isParked(html: string, title: string | undefined): boolean {
  return /this domain (?:is|may be) for sale|domain parking|sedoparking|parkingcrew|bodis\.com|buy this domain/i.test(
    `${title ?? ""} ${html.slice(0, 20_000)}`,
  );
}

async function browserAvailable(): Promise<boolean> {
  try {
    const status = await (await sharedBridge()).status();
    return status.browsers > 0;
  } catch {
    return false;
  }
}

/** Asks Chrome about what plain HTTP left open, and about a sample of what it called fine. */
async function settleInChrome(
  results: SiteCheck[],
  options: CheckOptions,
  spotCheck: { checked: number; disagreed: string[] },
): Promise<void> {
  const open = results.filter((result) => !SETTLED.has(result.verdict));
  const fine = results.filter((result) => result.verdict === "ok");
  const sample = pick(fine, options.spotChecks ?? 5);
  const answers = await askChrome([...open, ...sample].map((result) => result.url));
  for (const result of open) {
    const answer = answers.get(result.url);
    if (answer) Object.assign(result, chromeVerdict(result, answer));
  }
  for (const result of sample) {
    const answer = answers.get(result.url);
    if (!answer) continue;
    spotCheck.checked++;
    const again = chromeVerdict(result, answer);
    if (again.verdict !== "ok" && again.verdict !== "js-shell")
      spotCheck.disagreed.push(`${result.host}: http ok, chrome ${again.verdict}`);
  }
}

type ChromeAnswer = Answer | { error: string };

function chromeVerdict(result: SiteCheck, answer: ChromeAnswer): Partial<SiteCheck> {
  if ("error" in answer) {
    if (/SITE_BLOCKED/.test(answer.error))
      return { verdict: "blocked", via: "chrome", reason: "the user blocked this site for agents" };
    return {
      verdict: "refused",
      via: "chrome",
      reason: `Chrome could not load it either (${answer.error})`,
    };
  }
  return { ...judge(answer), via: "chrome", url: result.url, host: result.host };
}

const BATCH = 12;

async function askChrome(urls: readonly string[]): Promise<Map<string, ChromeAnswer>> {
  const answers = new Map<string, ChromeAnswer>();
  if (!urls.length) return answers;
  const bridge = await sharedBridge();
  for (let index = 0; index < urls.length; index += BATCH) {
    const batch = urls.slice(index, index + BATCH);
    const values = (await bridge
      .run(chromeCode(batch), { session: "browser-crawl-check", timeoutMs: 45_000 })
      .catch((error: unknown) => batch.map(() => ({ error: String(error) })))) as ChromeAnswer[];
    batch.forEach((url, at) => answers.set(url, values[at] ?? { error: "no answer" }));
  }
  return answers;
}

/** One cell fetching a batch at once through the extension, i.e. Chrome's own network stack. */
function chromeCode(urls: readonly string[]): string {
  return `const urls = ${JSON.stringify(urls)};
await Promise.all(urls.map((url) => browser.fetch(url, { as: "text", timeoutMs: 15000 })
  .then((r) => ({ status: r.status, finalUrl: r.url || url, headers: r.headers || {}, html: String(r.text || "").slice(0, ${BODY_LIMIT}) }))
  .catch((error) => ({ error: String(error && error.message || error) }))));`;
}

function pick<T>(items: readonly T[], count: number): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index--) {
    const other = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[other]] = [copy[other] as T, copy[index] as T];
  }
  return copy.slice(0, count);
}

function countVerdicts(results: readonly SiteCheck[]): Partial<Record<SiteVerdict, number>> {
  const counts: Partial<Record<SiteVerdict, number>> = {};
  for (const result of results) counts[result.verdict] = (counts[result.verdict] ?? 0) + 1;
  return counts;
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
