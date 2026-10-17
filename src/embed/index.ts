import { useHostSiteApi } from "../background/integrations.js";
import { normalizeBoost } from "../shared/bundle.js";
import { errorText, type Reply } from "../shared/messages.js";
import { boostMatches } from "../shared/match.js";
import type { Boost, HealthReport } from "../shared/types.js";
import { setRuleRange, syncNetwork } from "../background/dnr.js";
import { listenToScripts } from "../background/gm.js";
import { recordHealth } from "../background/health.js";
import { syncScripts } from "../background/scripts.js";
import { planFor } from "../background/sites.js";
import {
  allBoosts,
  deleteBoost,
  getBoost,
  patchBoost,
  putBoost,
  setStorePrefix,
} from "../background/store.js";

// The boost engine inside another extension's service worker: saved boosts (styles, hidden
// elements, actions, network rules, scripts) apply in every tab, without Site Boosts installed.
// Its storage keys, network rule ids, script ids and messages are namespaced, so it never meets
// the host's own. Authoring, repairs, the toolbar UI and userscript installs stay in Site Boosts.

export const MESSAGE_PREFIX = "boosts.";
const CONTENT_SCRIPT_ID = "sb-content";
const PAGE_PARTS = ["css", "sections", "zaps", "look", "actions", "html"] as const;

export interface BoostEngineOptions {
  /** The content script the host built with site-boosts/embed-build (writeContent). */
  contentScript: string;
  /**
   * Answers boosts' site API calls (sb.api) itself, e.g. through the host's own site-to-api.
   * Without it they go to a site-to-api server set in the settings, or to a companion extension.
   */
  siteApi?: (site: string, operation: string, params: Record<string, unknown>) => Promise<unknown>;
}

export interface BoostSummary {
  id: string;
  name: string;
  enabled: boolean;
  sites: Boost["sites"];
  parts: string[];
  updated: number;
}

export interface BoostEngine {
  list(url?: string): Promise<BoostSummary[]>;
  get(id: string): Promise<Boost | undefined>;
  /** Saves a boost (new without an id, replaced with one) and applies it in open tabs. */
  save(input: Record<string, unknown>): Promise<BoostSummary>;
  remove(id: string): Promise<void>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
}

const partsOf = (boost: Boost): string[] =>
  [...PAGE_PARTS, "js", "network"].filter((part) => {
    const value = (boost as unknown as Record<string, unknown>)[part];
    return Array.isArray(value) ? value.length > 0 : Boolean(value);
  });

const summary = (boost: Boost): BoostSummary => ({
  id: boost.id,
  name: boost.name,
  enabled: boost.enabled,
  sites: boost.sites,
  parts: partsOf(boost),
  updated: boost.updated,
});

const hasPagePart = (boost: Boost): boolean =>
  PAGE_PARTS.some((part) => {
    const value = (boost as unknown as Record<string, unknown>)[part];
    return Array.isArray(value) ? value.length > 0 : Boolean(value);
  });

/** The content script only runs while some boost changes pages. */
async function syncContentScript(file: string): Promise<void> {
  const wanted = (await allBoosts()).some((b) => b.enabled && hasPagePart(b));
  const registered = await chrome.scripting.getRegisteredContentScripts({
    ids: [CONTENT_SCRIPT_ID],
  });
  if (wanted && !registered.length)
    await chrome.scripting.registerContentScripts([
      {
        id: CONTENT_SCRIPT_ID,
        js: [file],
        matches: ["http://*/*", "https://*/*"],
        runAt: "document_start",
        allFrames: true,
        persistAcrossSessions: true,
      },
    ]);
  if (!wanted && registered.length)
    await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
}

async function refreshTabs(): Promise<void> {
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  await Promise.allSettled(
    tabs.map((t) =>
      chrome.tabs.sendMessage(t.id as number, { kind: `${MESSAGE_PREFIX}plan.refresh` }),
    ),
  );
}

type Handler = (message: Record<string, unknown>, sender: chrome.runtime.MessageSender) => unknown;

function frameTarget(sender: chrome.runtime.MessageSender): chrome.scripting.InjectionTarget {
  if (sender.tab?.id === undefined) throw new Error("No tab");
  return { tabId: sender.tab.id, frameIds: [sender.frameId ?? 0] };
}

const contentHandlers: Record<string, Handler> = {
  "page.plan": (m) => planFor(String(m.url), m.top !== false),
  "page.health": async (m, sender) => {
    for (const { boostId, report } of (m.reports as { boostId: string; report: HealthReport }[]) ??
      [])
      await recordHealth(boostId, report, sender.tab?.id);
  },
  "css.insert": (m, sender) =>
    chrome.scripting.insertCSS({ target: frameTarget(sender), css: String(m.css), origin: "USER" }),
  "css.remove": (m, sender) =>
    chrome.scripting.removeCSS({ target: frameTarget(sender), css: String(m.css), origin: "USER" }),
};

export function startBoostEngine(options: BoostEngineOptions): BoostEngine {
  setStorePrefix("boosts:");
  setRuleRange(500_000, 599_999);

  let chain: Promise<void> = Promise.resolve();
  const changed = (): Promise<void> => {
    chain = chain
      .catch(() => undefined)
      .then(async () => {
        await Promise.allSettled([
          syncScripts(),
          syncNetwork(),
          syncContentScript(options.contentScript),
        ]);
        await refreshTabs();
      });
    return chain;
  };

  listenToScripts();
  if (options.siteApi) useHostSiteApi(options.siteApi);
  chrome.runtime.onMessage.addListener((message: Record<string, unknown>, sender, reply) => {
    const kind = typeof message?.kind === "string" ? message.kind : "";
    if (!kind.startsWith(MESSAGE_PREFIX) || sender.id !== chrome.runtime.id || !sender.tab)
      return false;
    const handler = contentHandlers[kind.slice(MESSAGE_PREFIX.length)];
    if (!handler) return false;
    Promise.resolve()
      .then(() => handler(message, sender))
      .then(
        (value) => reply({ ok: true, value: value ?? null } satisfies Reply),
        (error: unknown) => reply({ ok: false, error: errorText(error) } satisfies Reply),
      );
    return true;
  });
  chrome.runtime.onInstalled.addListener(() => void changed());
  chrome.runtime.onStartup.addListener(() => void changed());

  return {
    async list(url) {
      const boosts = await allBoosts();
      return (url ? boosts.filter((b) => boostMatches(b, url)) : boosts).map(summary);
    },
    get: getBoost,
    async save(input) {
      const existing = typeof input.id === "string" ? await getBoost(input.id) : undefined;
      const boost = normalizeBoost({
        ...input,
        created: existing?.created,
        order: existing?.order ?? (await allBoosts()).length,
      });
      const saved = await putBoost(boost, "companion", existing ? "Changed" : "Created");
      await changed();
      return summary(saved);
    },
    async remove(id) {
      await deleteBoost(id);
      await changed();
    },
    async setEnabled(id, enabled) {
      if (!(await patchBoost(id, { enabled }))) throw new Error(`No boost ${id}`);
      await changed();
    },
  };
}
