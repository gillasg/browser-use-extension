import { ruleDomains } from "./match.js";
import type { Boost, HeaderChange, NetworkRule } from "./types.js";

// Network boosts become declarativeNetRequest rules scoped to the boost's sites.

type Rule = chrome.declarativeNetRequest.Rule;
type ResourceType = chrome.declarativeNetRequest.ResourceType;

export const ALL_TYPES = [
  "main_frame",
  "sub_frame",
  "stylesheet",
  "script",
  "image",
  "font",
  "object",
  "xmlhttprequest",
  "ping",
  "csp_report",
  "media",
  "websocket",
  "webtransport",
  "webbundle",
  "other",
] as ResourceType[];

/** Common ad and tracking hosts, for the "Block ads and trackers" switch. */
export const TRACKER_DOMAINS = [
  "doubleclick.net",
  "googlesyndication.com",
  "googleadservices.com",
  "google-analytics.com",
  "googletagmanager.com",
  "googletagservices.com",
  "adservice.google.com",
  "amazon-adsystem.com",
  "adnxs.com",
  "criteo.com",
  "criteo.net",
  "taboola.com",
  "outbrain.com",
  "scorecardresearch.com",
  "quantserve.com",
  "hotjar.com",
  "mixpanel.com",
  "segment.io",
  "segment.com",
  "fullstory.com",
  "clarity.ms",
  "connect.facebook.net",
  "ads-twitter.com",
  "analytics.tiktok.com",
  "bat.bing.com",
  "pubmatic.com",
  "rubiconproject.com",
  "openx.net",
  "casalemedia.com",
  "moatads.com",
  "adsrvr.org",
  "teads.tv",
  "yieldmo.com",
  "media.net",
  "branch.io",
  "newrelic.com",
  "nr-data.net",
  "chartbeat.com",
  "optimizely.com",
];

function headerInfo(
  changes: HeaderChange[] | undefined,
): chrome.declarativeNetRequest.ModifyHeaderInfo[] | undefined {
  if (!changes?.length) return undefined;
  return changes.map((change) =>
    change.value === undefined
      ? { header: change.name, operation: "remove" as chrome.declarativeNetRequest.HeaderOperation }
      : {
          header: change.name,
          operation: "set" as chrome.declarativeNetRequest.HeaderOperation,
          value: change.value,
        },
  );
}

function ruleAction(rule: NetworkRule): chrome.declarativeNetRequest.RuleAction {
  const type = (name: string): chrome.declarativeNetRequest.RuleActionType =>
    name as chrome.declarativeNetRequest.RuleActionType;
  if (rule.action === "block") return { type: type("block") };
  if (rule.action === "allow") return { type: type("allow") };
  if (rule.action === "redirect") {
    const target = rule.redirect ?? "";
    return {
      type: type("redirect"),
      redirect: rule.regex && /\\\d/.test(target) ? { regexSubstitution: target } : { url: target },
    };
  }
  return {
    type: type("modifyHeaders"),
    requestHeaders: headerInfo(rule.requestHeaders),
    responseHeaders: headerInfo(rule.responseHeaders),
  };
}

/** Which requests: by URL filter or regex, and by the domains requested. */
function target(rule: NetworkRule): chrome.declarativeNetRequest.RuleCondition {
  const result: chrome.declarativeNetRequest.RuleCondition = {};
  if (rule.regex) result.regexFilter = rule.regex;
  else if (rule.match) result.urlFilter = rule.match;
  if (rule.domains?.length) result.requestDomains = rule.domains;
  return result;
}

function condition(
  rule: NetworkRule,
  domains: string[] | undefined,
): chrome.declarativeNetRequest.RuleCondition {
  const result = target(rule);
  const scope = rule.scope ?? (rule.action === "headers" ? "to-site" : "from-site");
  if (domains?.length && scope === "from-site") result.initiatorDomains = domains;
  if (domains?.length && scope === "to-site")
    result.requestDomains = [...(result.requestDomains ?? []), ...domains];
  const types = resourceTypes(rule, scope);
  if (types) result.resourceTypes = types;
  return result;
}

/** Rules on pages themselves (headers, redirects, a site's own requests) cover every kind of request. */
function resourceTypes(rule: NetworkRule, scope: NetworkRule["scope"]): ResourceType[] | undefined {
  if (rule.resourceTypes?.length) return rule.resourceTypes as ResourceType[];
  const everyType = rule.action === "headers" || rule.action === "redirect" || scope === "to-site";
  return everyType ? ALL_TYPES : undefined;
}

/** The rules for one boost, numbered from firstId. Rules for sites DNR cannot express are left out. */
export function networkRules(boost: Boost, firstId: number): Rule[] {
  if (!boost.network?.length) return [];
  const domains = ruleDomains(boost.sites);
  return boost.network.map((rule, index) => ({
    id: firstId + index,
    priority: rule.action === "allow" ? 3 : rule.action === "headers" ? 1 : 2,
    action: ruleAction(rule),
    condition: condition(rule, domains),
  }));
}

/** Readable lines for the review page. */
function requestsText(rule: NetworkRule): string {
  const domains = rule.domains ?? [];
  if (domains.length)
    return `requests to ${domains.slice(0, 5).join(", ")}${domains.length > 5 ? ` and ${domains.length - 5} more` : ""}`;
  const pattern = rule.match ?? rule.regex;
  return pattern ? `requests matching ${pattern}` : "every request";
}

export function describeNetwork(rule: NetworkRule): string {
  const what = requestsText(rule);
  if (rule.action === "block") return `Blocks ${what}`;
  if (rule.action === "allow") return `Always allows ${what}`;
  if (rule.action === "redirect") return `Redirects ${what} to ${rule.redirect}`;
  const names = [...(rule.requestHeaders ?? []), ...(rule.responseHeaders ?? [])].map(
    (h) => h.name,
  );
  return `Changes the ${names.join(", ")} header${names.length === 1 ? "" : "s"} on ${what}`;
}
