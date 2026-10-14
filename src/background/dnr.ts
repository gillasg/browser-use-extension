import { errorText } from "../shared/messages.js";
import { networkRules } from "../shared/network.js";
import { allBoosts, getSettings, getSites, log } from "./store.js";

// Network boosts become dynamic declarativeNetRequest rules, rebuilt whenever boosts change.

let chain: Promise<void> = Promise.resolve();

export function syncNetwork(): Promise<void> {
  chain = chain.catch(() => undefined).then(doSync);
  return chain;
}

/** Every rule that should be active, with switched-off sites excluded. */
async function wantedRules(): Promise<chrome.declarativeNetRequest.Rule[]> {
  const settings = await getSettings();
  if (settings.paused) return [];
  const sites = Object.entries(await getSites());
  const offHosts = [
    ...sites.filter(([, state]) => state.off).map(([host]) => host),
    ...settings.blocklist.filter((entry) => !/[/*]/.test(entry)),
  ];
  const rules: chrome.declarativeNetRequest.Rule[] = [];
  for (const boost of await allBoosts()) {
    if (!boost.enabled || !boost.network?.length) continue;
    const excluded = [
      ...offHosts,
      ...sites.filter(([, state]) => state.boostsOff?.includes(boost.id)).map(([host]) => host),
    ];
    for (const rule of networkRules(boost, rules.length + 1)) {
      if (excluded.length) rule.condition.excludedInitiatorDomains = excluded;
      rules.push(rule);
    }
  }
  return rules;
}

async function doSync(): Promise<void> {
  const rules = await wantedRules();
  const removeRuleIds = (await chrome.declarativeNetRequest.getDynamicRules()).map(
    (rule) => rule.id,
  );
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: rules });
  } catch (error) {
    log({ level: "error", message: `Network rules were not applied: ${errorText(error)}` });
    // Apply what can be applied, one rule at a time, so one bad rule does not stop the rest.
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds });
    for (const rule of rules) {
      try {
        await chrome.declarativeNetRequest.updateDynamicRules({ addRules: [rule] });
      } catch (ruleError) {
        log({
          level: "error",
          message: `Rule ${JSON.stringify(rule.condition)}: ${errorText(ruleError)}`,
        });
      }
    }
  }
}
