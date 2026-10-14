import { normalizeBoost, shareCode } from "../shared/bundle.js";
import { sendToTab } from "../shared/messages.js";
import type { Boost, HealthReport, ModelSettings, Settings, Zap } from "../shared/types.js";
import { author, discard, keep, repair } from "./author.js";
import { exportBundle, exportZip, importText, importZip, syncWebdav } from "./backup.js";
import { menuCommands, runMenuCommand, valuesChangedOutside } from "./gm.js";
import { recordHealth } from "./health.js";
import {
  checkUpdates,
  install,
  prepare,
  prepareFromUrl,
  showSourceOnce,
  type Prepared,
} from "./install.js";
import { findCompanion } from "./integrations.js";
import { listModels, PROVIDERS } from "./models.js";
import { userScriptsAvailable } from "./scripts.js";
import { compileStyle } from "./styles.js";
import {
  addZap,
  getLook,
  hostOf,
  planFor,
  presetsFor,
  rollback,
  setLook,
  setPreset,
  toggleBoostOnSite,
  toggleSite,
  undo,
  type Preset,
} from "./sites.js";
import {
  allBoosts,
  allHealth,
  clearLog,
  deleteBoost,
  getBoost,
  getHealth,
  getLog,
  getRevisions,
  getSettings,
  getValues,
  patchBoost,
  putBoost,
  setHealth,
  setSettings,
  setValues,
} from "./store.js";

// Every request from the pages and the content script, by kind.

export type Sender = chrome.runtime.MessageSender;
export type Handler = (message: Record<string, unknown>, sender: Sender) => unknown;

/** After any change: re-register scripts, rebuild network rules, refresh open pages. */
let changed: () => Promise<void> = async () => undefined;
export function setChanged(callback: () => Promise<void>): void {
  changed = callback;
}

const after = async <T>(value: T): Promise<T> => {
  await changed();
  return value;
};

function tabOf(message: Record<string, unknown>, sender: Sender): number {
  const tabId = typeof message.tabId === "number" ? message.tabId : sender.tab?.id;
  if (tabId === undefined) throw new Error("No tab");
  return tabId;
}

/** Saving from the editor: userscripts and userstyles are rebuilt from their source. */
async function saveFromEditor(input: Boost): Promise<Boost> {
  const existing = await getBoost(input.id);
  if (input.kind !== "boost" && input.source && input.source !== existing?.source) {
    const prepared = await prepare(input.source, existing?.origin?.url);
    const boost = {
      ...prepared.boost,
      id: input.id,
      enabled: input.enabled,
      varValues: input.varValues,
      tags: input.tags,
      origin: existing?.origin ?? prepared.boost.origin,
      created: existing?.created ?? Date.now(),
    };
    return putBoost(boost, "user", "Edited");
  }
  return putBoost(
    await compileStyle(normalizeBoost({ ...input, updated: Date.now() })),
    "user",
    "Edited",
  );
}

const contentHandlers: Record<string, Handler> = {
  "page.plan": async (m, sender) => {
    const plan = await planFor(String(m.url), m.top !== false);
    if (m.top !== false && sender.tab?.id !== undefined) {
      const count = plan.siteDisabled || plan.paused ? 0 : plan.active.length;
      await chrome.action
        .setBadgeText({ tabId: sender.tab.id, text: count ? String(count) : "" })
        .catch(() => undefined);
    }
    return plan;
  },
  "page.health": async (m, sender) => {
    for (const { boostId, report } of (m.reports as { boostId: string; report: HealthReport }[]) ??
      [])
      await recordHealth(boostId, report, sender.tab?.id);
  },
  "css.insert": (m, sender) =>
    chrome.scripting.insertCSS({
      target: { tabId: tabOf(m, sender), frameIds: [sender.frameId ?? 0] },
      css: String(m.css),
      origin: "USER",
    }),
  "css.remove": (m, sender) =>
    chrome.scripting.removeCSS({
      target: { tabId: tabOf(m, sender), frameIds: [sender.frameId ?? 0] },
      css: String(m.css),
      origin: "USER",
    }),
  "author.run": (m, sender) =>
    author(
      tabOf(m, sender),
      String(m.request),
      typeof m.boostId === "string" ? m.boostId : undefined,
    ),
  "author.keep": (m, sender) => keep(tabOf(m, sender)),
  "author.discard": (m, sender) => discard(tabOf(m, sender)),
  "zap.add": async (m) => after(await addZap(String(m.url), m.zap as Zap)),
  "site.toggle": async (m) => after(await toggleSite(String(m.host), m.on === true)),
  "site.boost": async (m) =>
    after(await toggleBoostOnSite(String(m.host), String(m.id), m.on === true)),
  "boost.undo": async (m) => after(await undo(String(m.id))),
  "repair.run": async (m, sender) =>
    after(await repair(String(m.id), typeof m.tabId === "number" ? m.tabId : sender.tab?.id)),
  "open.manager": (m) =>
    chrome.tabs.create({
      url: chrome.runtime.getURL(
        m.id === "setup" ? "setup.html" : `manager.html${m.id ? `#boost/${String(m.id)}` : ""}`,
      ),
    }),
};

const boostHandlers: Record<string, Handler> = {
  "boosts.list": async () => ({ boosts: await allBoosts(), health: await allHealth() }),
  "boost.get": async (m) => {
    const id = String(m.id);
    return {
      boost: await getBoost(id),
      revisions: await getRevisions(id),
      health: await getHealth(id),
      values: await getValues(id),
    };
  },
  "boost.save": async (m) => after(await saveFromEditor(m.boost as Boost)),
  "boost.create": async (m) =>
    after(
      await putBoost(
        normalizeBoost({ ...(m.boost as object), id: undefined, created: undefined }),
        "user",
        "Created",
      ),
    ),
  "boost.delete": async (m) => after(await deleteBoost(String(m.id))),
  "boost.toggle": async (m) =>
    after(await patchBoost(String(m.id), { enabled: m.enabled === true })),
  "boost.patch": async (m) => after(await patchBoost(String(m.id), m.patch as Partial<Boost>)),
  "boost.rollback": async (m) => after(await rollback(String(m.id), Number(m.at))),
  "boost.order": async (m) => {
    const ids = m.ids as string[];
    for (const [index, id] of ids.entries()) await patchBoost(id, { order: index });
    return after(undefined);
  },
  "health.reset": (m) => setHealth(String(m.id), { status: "unknown", misses: 0 }),
  "values.set": async (m) => {
    const values = m.values as Record<string, unknown>;
    await setValues(String(m.id), values);
    valuesChangedOutside(String(m.id), values);
    return after(undefined);
  },
  "install.prepare": (m) =>
    typeof m.source === "string"
      ? prepare(m.source, typeof m.url === "string" ? m.url : undefined)
      : prepareFromUrl(String(m.url)),
  "install.confirm": async (m) => after(await install(m.prepared as Prepared)),
  "install.showSource": (m) => showSourceOnce(String(m.url)),
  "updates.check": async (m) =>
    after(
      await checkUpdates({
        ids: m.ids as string[] | undefined,
        apply: m.apply as boolean | undefined,
      }),
    ),
  "backup.export": (m) =>
    m.format === "zip"
      ? exportZip()
      : exportBundle(m.ids as string[] | undefined).then((b) => JSON.stringify(b, null, 2)),
  "backup.import": async (m) =>
    after(typeof m.zip === "string" ? await importZip(m.zip) : await importText(String(m.text))),
  "share.code": async (m) =>
    shareCode((await allBoosts()).filter((b) => (m.ids as string[]).includes(b.id))),
  "webdav.sync": async () => after(await syncWebdav()),
};

const pageHandlers: Record<string, Handler> = {
  "settings.get": () => getSettings(),
  "settings.set": async (m) => after(await setSettings(m.patch as Partial<Settings>)),
  status: async () => {
    const settings = await getSettings();
    return {
      userScripts: await userScriptsAvailable(),
      version: chrome.runtime.getManifest().version,
      model: Boolean(settings.model),
      companion: await findCompanion(),
      id: chrome.runtime.id,
    };
  },
  providers: () => PROVIDERS,
  "models.list": (m) => listModels(m.model as ModelSettings),
  "log.list": () => getLog(),
  "log.clear": () => clearLog(),
  "tab.plan": async (m) => {
    const tab = await chrome.tabs.get(Number(m.tabId));
    const host = hostOf(tab.url ?? "");
    return {
      plan: await planFor(tab.url ?? ""),
      url: tab.url,
      look: await getLook(host),
      presets: await presetsFor(host),
      menu: menuCommands(Number(m.tabId)),
    };
  },
  "menu.run": (m) => runMenuCommand(Number(m.tabId), String(m.boostId), String(m.id)),
  "look.set": async (m) => {
    const saved = await setLook(String(m.host), m.look as Boost["look"]);
    if (typeof m.tabId === "number")
      await sendToTab(m.tabId, "look.preview", { look: undefined }).catch(() => undefined);
    return after(saved);
  },
  "preset.set": async (m) =>
    after(await setPreset(String(m.host), m.preset as Preset, m.on === true)),
  "tab.send": (m) =>
    sendToTab(Number(m.tabId), String(m.message), (m.data as Record<string, unknown>) ?? {}),
};

export const handlers: Record<string, Handler> = {
  ...contentHandlers,
  ...boostHandlers,
  ...pageHandlers,
};
