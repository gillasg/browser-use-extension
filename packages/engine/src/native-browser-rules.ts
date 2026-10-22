import { onEngineInstall } from "./native-engine-install.js";
// Network rules for one agent tab: block ads, trackers, cookie banners or heavy media, set request
// headers such as Accept-Language, or answer a URL with a fixed response. Rules are session rules
// scoped to that tab's id, so the user's own tabs are never affected; they end when the tab closes.
type Rule = chrome.declarativeNetRequest.Rule;
type ResourceType = chrome.declarativeNetRequest.ResourceType;

const ADS = [
  "doubleclick.net",
  "googlesyndication.com",
  "googleadservices.com",
  "adservice.google.com",
  "amazon-adsystem.com",
  "adnxs.com",
  "criteo.com",
  "criteo.net",
  "taboola.com",
  "outbrain.com",
  "pubmatic.com",
  "rubiconproject.com",
  "openx.net",
  "media.net",
  "adsrvr.org",
  "moatads.com",
  "yieldmo.com",
  "smartadserver.com",
  "teads.tv",
  "sharethrough.com",
  "33across.com",
  "casalemedia.com",
];
const TRACKERS = [
  "google-analytics.com",
  "analytics.google.com",
  "hotjar.com",
  "scorecardresearch.com",
  "quantserve.com",
  "mixpanel.com",
  "segment.io",
  "fullstory.com",
  "clarity.ms",
  "bat.bing.com",
  "connect.facebook.net",
  "analytics.tiktok.com",
  "branch.io",
  "chartbeat.com",
  "newrelic.com",
  "nr-data.net",
  "mouseflow.com",
  "crazyegg.com",
];
const BANNERS = [
  "cookielaw.org",
  "onetrust.com",
  "cookiebot.com",
  "consensu.org",
  "trustarc.com",
  "didomi.io",
  "usercentrics.eu",
  "quantcast.com",
  "cookieyes.com",
  "termly.io",
  "iubenda.com",
  "privacy-mgmt.com",
];
const HEAVY: Record<string, ResourceType[]> = {
  images: ["image" as ResourceType],
  media: ["media" as ResourceType],
  fonts: ["font" as ResourceType],
};
const MAX_MOCK = 1_000_000;

onEngineInstall(() => {
  chrome.tabs.onRemoved.addListener((tabId) => void clearRules(tabId).catch(() => undefined));
});

export function rulesCall(tabId: number, value: Record<string, unknown>): Promise<unknown> {
  if (value.rules === "block") return addRules(tabId, blockRules(value));
  if (value.rules === "headers") return addRules(tabId, headerRules(value.headers));
  if (value.rules === "mock")
    return addRules(tabId, [mockRule(value.url, value.body, value.contentType)]);
  if (value.rules === "list") return listRules(tabId);
  if (value.rules === "clear") return clearRules(tabId);
  throw new Error("UNSUPPORTED: page.rules." + String(value.rules));
}

function blockRules(value: Record<string, unknown>): Omit<Rule, "id">[] {
  const domains = [
    ...(value.ads ? ADS : []),
    ...(value.trackers ? TRACKERS : []),
    ...(value.banners ? BANNERS : []),
  ];
  const rules: Omit<Rule, "id">[] = [];
  if (domains.length) rules.push(block({ requestDomains: domains }));
  const types = Object.entries(HEAVY).flatMap(([name, list]) => (value[name] ? list : []));
  if (types.length) rules.push(block({ resourceTypes: types }));
  for (const url of strings(value.urls)) rules.push(block({ urlFilter: url }));
  if (!rules.length)
    throw new Error("INVALID_RULE: pass ads, trackers, banners, images, media, fonts or urls");
  return rules;
}

function block(condition: chrome.declarativeNetRequest.RuleCondition): Omit<Rule, "id"> {
  return {
    priority: 1,
    action: { type: "block" as chrome.declarativeNetRequest.RuleActionType },
    condition,
  };
}

function headerRules(headers: unknown): Omit<Rule, "id">[] {
  if (!headers || typeof headers !== "object")
    throw new Error("INVALID_RULE: pass {header: value}");
  const requestHeaders = Object.entries(headers as Record<string, unknown>).map(
    ([header, value]) => ({
      header,
      operation: "set" as chrome.declarativeNetRequest.HeaderOperation,
      value: String(value),
    }),
  );
  if (!requestHeaders.length) throw new Error("INVALID_RULE: pass at least one header");
  return [
    {
      priority: 1,
      action: {
        type: "modifyHeaders" as chrome.declarativeNetRequest.RuleActionType,
        requestHeaders,
      },
      condition: {},
    },
  ];
}

function mockRule(url: unknown, body: unknown, contentType: unknown): Omit<Rule, "id"> {
  if (typeof url !== "string" || !url) throw new Error("INVALID_RULE: mock(urlFilter, body)");
  const text = typeof body === "string" ? body : JSON.stringify(body ?? null);
  if (text.length > MAX_MOCK) throw new Error("INVALID_RULE: mock body is too large");
  const type =
    typeof contentType === "string"
      ? contentType
      : typeof body === "string"
        ? "text/plain"
        : "application/json";
  const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(text)));
  return {
    priority: 2,
    action: {
      type: "redirect" as chrome.declarativeNetRequest.RuleActionType,
      redirect: { url: `data:${type};base64,${encoded}` },
    },
    condition: { urlFilter: url },
  };
}

async function addRules(tabId: number, rules: Omit<Rule, "id">[]): Promise<unknown> {
  const existing = await chrome.declarativeNetRequest.getSessionRules();
  // Ids from 500000 up belong to the boost engine and its script requests.
  let next = existing
    .filter((rule) => rule.id < 500_000)
    .reduce((max, rule) => Math.max(max, rule.id), 0);
  const addRules = rules.map((rule) => ({
    ...rule,
    id: ++next,
    condition: { ...rule.condition, tabIds: [tabId] },
  }));
  await chrome.declarativeNetRequest.updateSessionRules({ addRules });
  return { added: addRules.length, active: (await listRules(tabId)).length };
}

async function tabRules(tabId: number): Promise<Rule[]> {
  return (await chrome.declarativeNetRequest.getSessionRules()).filter((rule) =>
    rule.condition.tabIds?.includes(tabId),
  );
}

async function listRules(tabId: number): Promise<unknown[]> {
  return (await tabRules(tabId)).map((rule) => ({
    id: rule.id,
    type: rule.action.type,
    ...(rule.condition.requestDomains ? { domains: rule.condition.requestDomains.length } : {}),
    ...(rule.condition.resourceTypes ? { resourceTypes: rule.condition.resourceTypes } : {}),
    ...(rule.condition.urlFilter ? { url: rule.condition.urlFilter } : {}),
    ...(rule.action.requestHeaders
      ? { headers: rule.action.requestHeaders.map((h) => h.header) }
      : {}),
  }));
}

async function clearRules(tabId: number): Promise<unknown> {
  const removeRuleIds = (await tabRules(tabId)).map((rule) => rule.id);
  if (removeRuleIds.length)
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds });
  return { removed: removeRuleIds.length };
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
