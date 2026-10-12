// Google Search from the user's own browser: the request carries their cookies, language and
// region, so results match what they would see (local shops, prices, showtimes), with no API
// quota. Queries run one at a time with a short gap, because bursts trigger Google's bot checks.
const GAP_MS = 1200;
let queue: Promise<unknown> = Promise.resolve();
let last = 0;

export function googleCall(value: Record<string, unknown>): Promise<unknown> {
  if (value.google !== "search") throw new Error("UNSUPPORTED: google." + String(value.google));
  const query = String(value.query ?? "").trim();
  if (!query) throw new Error("INVALID_QUERY: google.search(query) needs text");
  const run = queue.then(() => fetchResults(query, value));
  queue = run.catch(() => undefined);
  return run;
}

async function fetchResults(query: string, value: Record<string, unknown>) {
  const wait = last + GAP_MS - Date.now();
  if (wait > 0) await new Promise((done) => setTimeout(done, wait));
  last = Date.now();
  const url = new URL("https://www.google.com/search");
  url.searchParams.set("q", query);
  url.searchParams.set("num", String(Math.min(20, Math.max(1, Number(value.limit ?? 10)))));
  if (typeof value.start === "number") url.searchParams.set("start", String(value.start));
  if (typeof value.language === "string") url.searchParams.set("hl", value.language);
  if (typeof value.country === "string") url.searchParams.set("gl", value.country);
  const times: Record<string, string> = { day: "d", week: "w", month: "m", year: "y" };
  if (typeof value.time === "string" && times[value.time])
    url.searchParams.set("tbs", "qdr:" + times[value.time]);
  const response = await fetch(url, { credentials: "include" });
  const finalUrl = response.url;
  if (/\/sorry\/|consent\.google\./.test(finalUrl) || response.status === 429)
    throw new Error(
      "GOOGLE_BLOCKED: Google asked for a check. Use the websearch tool, or open the results in a tab.",
    );
  if (!response.ok) throw new Error("GOOGLE_FAILED: HTTP " + response.status);
  return { html: (await response.text()).slice(0, 3_000_000), url: finalUrl };
}
