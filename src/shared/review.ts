import { describeRule } from "./match.js";
import { describeNetwork } from "./network.js";
import type { Action, Boost } from "./types.js";

// A readable account of what a boost can do, shown before installing or sharing.

export interface Review {
  level: "low" | "medium" | "high";
  sites: string[];
  lines: string[];
  warnings: string[];
}

const GRANT_WARNINGS: Record<string, string> = {
  GM_cookie: "Can read and change your cookies",
  "GM.cookie": "Can read and change your cookies",
  GM_download: "Can download files",
  "GM.download": "Can download files",
  GM_openInTab: "Can open tabs",
  "GM.openInTab": "Can open tabs",
  GM_setClipboard: "Can write to your clipboard",
  "GM.setClipboard": "Can write to your clipboard",
  GM_notification: "Can show notifications",
  "GM.notification": "Can show notifications",
};

const ANTIFEATURES: Record<string, string> = {
  ads: "The author says it shows ads",
  tracking: "The author says it tracks you",
  miner: "The author says it mines cryptocurrency",
  membership: "The author says it needs a paid membership",
  referral: "The author says it adds referral links",
  payment: "The author says some features are paid",
};

function connectLine(boost: Boost): string | undefined {
  const grants = boost.meta?.grant ?? [];
  const canRequest = grants.some((g) => /xmlhttpRequest|xmlHttpRequest/.test(g));
  if (!canRequest && !/\bSB\.(fetch|api)\b/.test(boost.js ?? "")) return undefined;
  const connect = boost.meta?.connect ?? [];
  if (!connect.length || connect.includes("*"))
    return "Can send requests, with your logins, to any site";
  return `Can send requests, with your logins, to: ${connect.join(", ")}`;
}

/** What the script's grants and its author's declared antifeatures allow, as warnings. */
function scriptWarnings(boost: Boost): string[] {
  const warnings = new Set<string>();
  const connect = connectLine(boost);
  if (connect) warnings.add(connect);
  for (const grant of boost.meta?.grant ?? []) {
    const warning = GRANT_WARNINGS[grant];
    if (warning) warnings.add(warning);
  }
  for (const feature of boost.meta?.antifeatures ?? [])
    warnings.add(ANTIFEATURES[feature.split(/\s+/)[0] ?? ""] ?? `The author lists: ${feature}`);
  return [...warnings];
}

function scriptLines(boost: Boost, review: Review): void {
  if (!boost.js) return;
  review.lines.push(
    `Runs JavaScript${boost.jsWorld === "isolated" ? "" : " with access to the page's own data"}`,
  );
  review.level = connectLine(boost) ? "high" : "medium";
  const loads = boost.meta?.require ?? (boost.requires ?? []).map((r) => r.url);
  if (loads.length)
    review.lines.push(`Loads code from: ${loads.map((url) => url.split("#")[0]).join(", ")}`);
  review.warnings.push(...scriptWarnings(boost));
}

function actionLine(action: Action): string {
  const selector = "selector" in action && action.selector ? ` ${action.selector}` : "";
  const text = "text" in action && action.text ? ` "${action.text}"` : "";
  return `Acts on its own: ${action.do}${selector}${text}`;
}

/** Changes to how pages look and behave. */
function pageLines(boost: Boost): string[] {
  const zaps = boost.zaps?.length ?? 0;
  return [
    boost.css || boost.sections?.length ? "Changes how pages look (CSS)" : "",
    boost.look ? "Changes colours, fonts or layout" : "",
    zaps ? `Hides ${zaps} kind${zaps === 1 ? "" : "s"} of element` : "",
    boost.html?.length ? "Adds content to pages" : "",
    ...(boost.actions ?? []).map(actionLine),
  ].filter(Boolean);
}

export function reviewBoost(boost: Boost): Review {
  const review: Review = {
    level: "low",
    sites: boost.sites.map(describeRule),
    lines: pageLines(boost),
    warnings: [],
  };
  for (const rule of boost.network ?? []) {
    review.lines.push(describeNetwork(rule));
    if (rule.action === "redirect" || rule.responseHeaders?.length) review.level = "medium";
  }
  scriptLines(boost, review);
  const everywhere = boost.sites.some((s) => s.type === "all" || s.value === "<all_urls>");
  if (everywhere && review.level !== "low") review.warnings.push("Runs on every site");
  return review;
}
