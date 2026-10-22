import { toHar, type NetworkEntry } from "./native-browser-network-format.js";

// What a recording hands over for learning a site's API after each step: the finished
// requests not handed over before, as HAR, without what must never be saved (cookies and the
// cookies a response sets, passwords and card numbers in bodies). Passive recordings forget
// what they hand over, so a long task doesn't pile up requests.

const TRACKERS =
  /(^|\.)(google-analytics\.com|googletagmanager\.com|doubleclick\.net|googlesyndication\.com|googleadservices\.com|adservice\.google\.com|facebook\.net|connect\.facebook\.com|segment\.(io|com)|sentry\.io|hotjar\.(com|io)|mixpanel\.com|amplitude\.com|datadoghq\.com|browser-intake-datadoghq\.com|nr-data\.net|newrelic\.com|clarity\.ms|fullstory\.com|heap(analytics)?\.io|intercom\.io|branch\.io|appsflyer\.com|adnxs\.com|criteo\.(com|net)|taboola\.com|outbrain\.com|scorecardresearch\.com|quantserve\.com|bing\.com\/bat|bat\.bing\.com|snapchat\.com|tiktok\.com\/api\/v\d\/pixel|analytics\.)/i;
const TRACKER_PATHS = /\/(collect|beacon|pixel|track|telemetry|log_event|jserror|rum)(\/|\?|$)/i;
const SECRET_HEADERS = new Set(["cookie", "set-cookie"]);
const SECRET_FIELDS = /pass(word|wd)?|pwd|otp|one.?time|cvv|cvc|card.?number|security.?code|pin$/i;

interface Taking {
  entries: Map<string, NetworkEntry>;
  passive?: boolean;
  taken?: Set<string>;
  bodyBytes: number;
}

/** Ad, analytics and error-reporting calls: never part of a site's own API. */
export function isTrackerUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return TRACKERS.test(parsed.hostname) || TRACKER_PATHS.test(parsed.pathname);
  } catch {
    return true;
  }
}

/** The finished requests since the last take, as HAR, with secrets removed. */
export function takeLearned(recorder: Taking): unknown {
  recorder.taken ??= new Set();
  const ready = [...recorder.entries.values()].filter(
    (entry) => entry.done && !entry.requestBodyPending && !recorder.taken?.has(entry.id),
  );
  for (const entry of ready) {
    if (recorder.passive) {
      recorder.bodyBytes -= entry.body?.length ?? 0;
      recorder.entries.delete(entry.id);
    } else recorder.taken.add(entry.id);
  }
  return toHar(ready.filter((entry) => !isTrackerUrl(entry.url)).map(withoutSecrets));
}

function withoutSecrets(entry: NetworkEntry): NetworkEntry {
  const clean = (headers: Record<string, string> | undefined) =>
    headers &&
    Object.fromEntries(
      Object.entries(headers).filter(([name]) => !SECRET_HEADERS.has(name.toLowerCase())),
    );
  const requestHeaders = clean(entry.requestHeaders) ?? {};
  const responseHeaders = clean(entry.responseHeaders);
  return {
    ...entry,
    requestHeaders,
    ...(responseHeaders ? { responseHeaders } : {}),
    ...(entry.requestBody !== undefined ? { requestBody: scrub(entry.requestBody) } : {}),
  };
}

/** Passwords and card details in a JSON or form body become "[removed]". */
function scrub(body: string): string {
  try {
    return JSON.stringify(scrubValue(JSON.parse(body) as unknown));
  } catch {
    if (!body.includes("=")) return body;
    const form = new URLSearchParams(body);
    for (const key of [...form.keys()]) if (SECRET_FIELDS.test(key)) form.set(key, "[removed]");
    return form.toString();
  }
}

function scrubValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SECRET_FIELDS.test(key) && typeof item !== "object" ? "[removed]" : scrubValue(item),
    ]),
  );
}
