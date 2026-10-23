import type { Health, HealthReport } from "./types.js";

// Whether a boost still works: each visit is compared with the last good visit to the same kind
// of page, so a selector that only exists on some pages does not look broken on the others.

/** Visits in a row with something missing before a boost counts as broken. */
export const MISSES_TO_BREAK = 2;

/** The shape of a URL: numbers, ids and slugs become *, so /p/123 and /p/456 are the same page. */
export function pageKey(url: string, source: HealthReport["source"]): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname
      .split("/")
      .map((part) =>
        /\d/.test(part) || part.length > 24 || /^[\w-]{12,}$/.test(part) ? "*" : part,
      )
      .join("/");
    return `${source}:${parsed.hostname}${path}`;
  } catch {
    return `${source}:${url}`;
  }
}

/** Selectors that matched on the last good visit to this kind of page and match nothing now. */
function lostSelectors(before: HealthReport | undefined, report: HealthReport): string[] {
  if (!before) return [];
  const now = new Map(report.selectors.map((s) => [s.selector, s.count]));
  return before.selectors.filter((s) => s.count > 0 && !now.get(s.selector)).map((s) => s.selector);
}

/** Remembers a good visit, keeping the 30 most recent kinds of page. */
function remember(
  good: Record<string, HealthReport>,
  key: string,
  report: HealthReport,
): Record<string, HealthReport> {
  const next = { ...good };
  delete next[key];
  next[key] = report;
  const keys = Object.keys(next);
  for (const old of keys.slice(0, Math.max(0, keys.length - 30))) delete next[old];
  return next;
}

/** A visit where nothing that worked before stopped working. */
function healthyVisit(previous: Health, report: HealthReport, key: string): Health {
  const good = previous.good ?? {};
  const matchedSome = report.selectors.some((s) => s.count > 0);
  const status =
    matchedSome || !report.selectors.length || report.actionsRun > 0 ? "ok" : previous.status;
  return {
    ...previous,
    status,
    last: report,
    good: matchedSome ? remember(good, key, report) : good,
    misses: 0,
    broken: [],
  };
}

/** Updates health with one visit's report. */
export function nextHealth(previous: Health, report: HealthReport): Health {
  const key = pageKey(report.url, report.source);
  const good = previous.good ?? {};
  const before = good[key];
  const lost = lostSelectors(before, report);
  const stillWorks = report.selectors.length === 0 || report.selectors.some((s) => s.count > 0);
  const failing = lost.length > 0 || report.errors.length > 0 || (!stillWorks && Boolean(before));
  if (!failing) return healthyVisit(previous, report, key);
  const misses = previous.misses + 1;
  return {
    ...previous,
    status: misses >= MISSES_TO_BREAK ? "broken" : previous.status,
    last: report,
    lastGood: before ?? previous.lastGood,
    good,
    misses,
    broken: lost,
  };
}

/** A report from the page combined with what the script reported, for display. */
export function describeHealth(health: Health): string {
  if (health.status === "broken") {
    if (health.broken?.length) return `Stopped matching: ${health.broken.slice(0, 3).join(", ")}`;
    if (health.last?.errors.length) return `Errors: ${health.last.errors[0]}`;
    return "Stopped working";
  }
  if (health.status === "ok") {
    const matched = health.last?.selectors.reduce((sum, s) => sum + s.count, 0) ?? 0;
    return matched
      ? `Working: ${matched} element${matched === 1 ? "" : "s"} on the last visit`
      : "Working";
  }
  return "Not seen yet";
}
