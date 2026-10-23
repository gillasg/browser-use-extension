import { onEngineInstall } from "./native-engine-install.js";

// Sites the agent must not touch. The machine says which (a block list, and optionally an
// "only these sites" list for a run); the engine holds every route to them shut while a cell
// runs: steps that open or navigate to a blocked address, browser.fetch and site API calls, and,
// for every tab the cell acts in, a network rule that blocks the tab's own requests to those
// sites, so a click, a redirect or a script on a hostile page cannot reach them either.

export interface SiteRules {
  blocked: string[];
  only: string[];
}

export const NO_RULES: SiteRules = { blocked: [], only: [] };
const RULE_BASE = 700_000;
const RULE_SPAN = 90_000;
const ALL_TYPES = [
  "main_frame",
  "sub_frame",
  "xmlhttprequest",
  "script",
  "image",
  "media",
  "font",
  "stylesheet",
  "websocket",
  "ping",
  "csp_report",
  "object",
  "webtransport",
  "webbundle",
  "other",
] as chrome.declarativeNetRequest.ResourceType[];
const ruleIds = new Map<number, number[]>();
let nextRule = 0;

/** The list the user keeps in the extension's settings, under this storage key. */
export const BLOCKED_SITES_KEY = "blocked-sites";

export function parseRules(value: unknown): SiteRules {
  const rules = (value ?? {}) as { blocked?: unknown; only?: unknown };
  return { blocked: hosts(rules.blocked), only: hosts(rules.only) };
}

/**
 * The machine's rules for this run plus the extension's own block list. `allow` from the machine
 * lifts a block for this run (the user named that site in the request).
 */
export async function combinedRules(fromHost: unknown): Promise<SiteRules> {
  const host = parseRules(fromHost);
  const allow = hosts((fromHost as { allow?: unknown } | null)?.allow);
  const saved: Record<string, unknown> = await chrome.storage.local
    .get(BLOCKED_SITES_KEY)
    .catch(() => ({}));
  const stored = saved[BLOCKED_SITES_KEY];
  const blocked = [...new Set([...host.blocked, ...hosts(stored)])].filter(
    (site) => !allow.some((allowed) => matches(allowed, site) || matches(site, allowed)),
  );
  return { blocked, only: host.only };
}

function hosts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => hostOf(String(item)))
    .filter((host): host is string => Boolean(host))
    .slice(0, 200);
}

function hostOf(value: string): string | undefined {
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(value) ? value : "https://" + value);
    return url.hostname.toLowerCase().replace(/^www\./, "") || undefined;
  } catch {
    return undefined;
  }
}

function matches(host: string, site: string): boolean {
  return host === site || host.endsWith("." + site);
}

/** The reason a URL or site is off limits, or undefined when the agent may use it. */
export function blockedReason(rules: SiteRules, address: string): string | undefined {
  const host = hostOf(address);
  if (!host || !/^(https?:|[a-z0-9])/i.test(address)) return undefined;
  if (rules.blocked.some((site) => matches(host, site)))
    return `SITE_BLOCKED: the user blocked ${host} for the agent. Do not use it; tell the user if the task needs it.`;
  if (rules.only.length && !rules.only.some((site) => matches(host, site)))
    return `SITE_BLOCKED: this task may only use ${rules.only.join(", ")}; ${host} is not one of them.`;
  return undefined;
}

export function assertAllowed(rules: SiteRules, address: unknown): void {
  if (typeof address !== "string" || !address) return;
  const reason = blockedReason(rules, address);
  if (reason) throw new Error(reason);
}

/** Shuts this tab's own traffic to blocked sites (and, with an "only" list, its navigations). */
export async function guardTab(tabId: number, rules: SiteRules): Promise<void> {
  if (ruleIds.has(tabId) || (!rules.blocked.length && !rules.only.length)) return;
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (tab?.url) assertAllowed(rules, tab.url);
  const addRules: chrome.declarativeNetRequest.Rule[] = [];
  if (rules.blocked.length)
    addRules.push(rule({ requestDomains: rules.blocked, resourceTypes: ALL_TYPES }, tabId));
  if (rules.only.length)
    addRules.push(
      rule(
        { excludedRequestDomains: rules.only, resourceTypes: ["main_frame", "sub_frame"] },
        tabId,
      ),
    );
  ruleIds.set(
    tabId,
    addRules.map((item) => item.id),
  );
  await chrome.declarativeNetRequest.updateSessionRules({ addRules });
}

function rule(
  condition: chrome.declarativeNetRequest.RuleCondition,
  tabId: number,
): chrome.declarativeNetRequest.Rule {
  return {
    id: RULE_BASE + (nextRule++ % RULE_SPAN),
    priority: 3,
    action: { type: "block" as chrome.declarativeNetRequest.RuleActionType },
    condition: { ...condition, tabIds: [tabId] },
  };
}

/** Lifts the rules once the cell that set them is finished. */
export async function releaseTabs(tabIds: Iterable<number>): Promise<void> {
  const removeRuleIds: number[] = [];
  for (const tabId of tabIds) {
    removeRuleIds.push(...(ruleIds.get(tabId) ?? []));
    ruleIds.delete(tabId);
  }
  if (removeRuleIds.length)
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds }).catch(() => undefined);
}

onEngineInstall(() => {
  chrome.tabs.onRemoved.addListener((tabId) => void releaseTabs([tabId]));
});
