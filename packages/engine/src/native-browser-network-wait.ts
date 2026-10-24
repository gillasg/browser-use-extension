import type { NetworkEntry } from "./native-browser-network-format.js";

// One request by what it looks like: a URL substring or regex, optionally a method and statuses.
// page.network.waitFor uses it, so a click can be followed by the call it causes without a sleep.

/** What a waiter looks at: enough to tell requests apart, whether done or not. */
export type Waitable = Pick<NetworkEntry, "url" | "method" | "status" | "failed" | "done">;

type StatusTest = (status: number) => boolean;

const PREVIEW = 600;

export function waitMatcher(options: Record<string, unknown>): (entry: Waitable) => boolean {
  const urls = urlTest(
    typeof options.match === "string" ? options.match : undefined,
    options.regex === true,
  );
  const method = typeof options.method === "string" ? options.method.toUpperCase() : undefined;
  const status = statusMatcher(options.status);
  return (entry) =>
    urls(entry.url) &&
    (!method || entry.method === method) &&
    (!status || (entry.status !== undefined && status(entry.status)));
}

/** "api/x", "/\/api\/x/" — a substring unless it was given as a regex. */
function urlTest(match: string | undefined, regex: boolean): (url: string) => boolean {
  if (!match) return () => true;
  if (!regex) return (url) => url.includes(match);
  try {
    const pattern = new RegExp(match);
    return (url) => pattern.test(url);
  } catch {
    // A regex that does not compile is still a recognizable substring.
    return (url) => url.includes(match);
  }
}

/** 200, "2xx", ">=400", ["3xx", 404]: a status, a class or a comparison. */
export function statusMatcher(want: unknown): StatusTest | undefined {
  const tests = statusTests(Array.isArray(want) ? want : [want]);
  if (!tests.length) return undefined;
  return (status) => tests.some((test) => test(status));
}

function statusTests(items: readonly unknown[]): StatusTest[] {
  const tests: StatusTest[] = [];
  for (const item of items) {
    const test =
      typeof item === "number" && Number.isFinite(item)
        ? (status: number) => status === item
        : typeof item === "string"
          ? statusTest(item)
          : undefined;
    if (test) tests.push(test);
  }
  return tests;
}

function statusTest(text: string): StatusTest | undefined {
  const groups = /^(>=|<=|>|<)?\s*(.+)$/.exec(text.trim().toLowerCase());
  const compare = groups?.[1];
  const body = groups?.[2] ?? "";
  const range = /^([1-5])xx$/.exec(body);
  const exact = /^\d{3}$/.test(body);
  if (!range && !exact) return undefined;
  const low = range ? Number(range[1]) * 100 : Number(body);
  const high = range ? low + 99 : low;
  if (compare === ">=") return (status) => status >= low;
  if (compare === "<=") return (status) => status <= high;
  if (compare === ">") return (status) => status > high;
  if (compare === "<") return (status) => status < low;
  return (status) => status >= low && status <= high;
}

/** How a timeout names what it was waiting for: /api\/items/, POST, status 2xx. */
export function describeWait(options: Record<string, unknown>): string {
  const match = typeof options.match === "string" ? options.match : "";
  const parts = [match ? (options.regex === true ? `/${match}/` : `"${match}"`) : "any URL"];
  if (typeof options.method === "string" && options.method)
    parts.push(options.method.toUpperCase());
  const status =
    typeof options.status === "string" || typeof options.status === "number"
      ? String(options.status)
      : Array.isArray(options.status)
        ? options.status.join("/")
        : "";
  if (status) parts.push("status " + status);
  return parts.join(", ");
}

/** The body as an agent reads it: parsed JSON when it is small, otherwise the first characters. */
export function bodyPreview(entry: NetworkEntry): Record<string, unknown> {
  if (entry.body === undefined)
    return entry.bodyBase64 ? { binary: true, bytes: entry.size ?? 0 } : { unavailable: true };
  const text = entry.body;
  const result: Record<string, unknown> = {};
  if (text.length <= 4000) {
    try {
      result.json = JSON.parse(text) as unknown;
      return result;
    } catch {
      // Not JSON: a text preview.
    }
  }
  result.text = text.slice(0, PREVIEW);
  if (text.length > PREVIEW) result.truncated = true;
  return result;
}
