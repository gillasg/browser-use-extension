import { errorText } from "../shared/messages.js";
import { autoRepair, setAfterSave } from "./author.js";
import { syncNetwork } from "./dnr.js";
import { listenToCompanions } from "./external.js";
import { listenToScripts } from "./gm.js";
import { handlers, setChanged } from "./handlers.js";
import { onBroken } from "./health.js";
import { checkUpdates, interceptInstalls } from "./install.js";
import { runOnce, syncScripts } from "./scripts.js";
import { allBoosts, getSettings } from "./store.js";

// The service worker: wires messages, script registration, network rules, menus and updates.

async function refreshTabs(): Promise<void> {
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(
    tabs
      .filter((t) => t.id !== undefined && /^(https?|file):/.test(t.url ?? ""))
      .map((t) => chrome.tabs.sendMessage(t.id as number, { kind: "plan.refresh" })),
  );
}

async function syncMenus(): Promise<void> {
  await chrome.contextMenus.removeAll();
  const scripts = (await allBoosts()).filter(
    (b) => b.enabled && b.js && b.runAt === "context-menu",
  );
  if (!scripts.length) return;
  chrome.contextMenus.create({ id: "sb-root", title: "Site Boosts", contexts: ["all"] });
  for (const boost of scripts)
    chrome.contextMenus.create({
      id: `sb-run:${boost.id}`,
      parentId: "sb-root",
      title: boost.name,
      contexts: ["all"],
    });
}

let chain: Promise<void> = Promise.resolve();
/** Everything that follows a change to boosts or settings, one pass at a time. */
function changed(): Promise<void> {
  chain = chain
    .catch(() => undefined)
    .then(async () => {
      await Promise.all([syncScripts(), syncNetwork(), syncMenus()]);
      await refreshTabs();
    });
  return chain;
}

async function scheduleUpdates(): Promise<void> {
  const { updates } = await getSettings();
  await chrome.alarms.clear("updates");
  if (updates.enabled)
    await chrome.alarms.create("updates", { periodInMinutes: Math.max(60, updates.hours * 60) });
}

setChanged(changed);
setAfterSave(async () => changed());
listenToScripts();
listenToCompanions(changed);
interceptInstalls();
onBroken((boostId, tabId) => void autoRepair(boostId, tabId).then(changed));

chrome.runtime.onMessage.addListener((message: Record<string, unknown>, sender, reply) => {
  if (message?.target === "offscreen") return false;
  const handler = handlers[String(message?.kind)];
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(message, sender))
    .then(
      (value) => reply({ ok: true, value: value ?? null }),
      (error: unknown) => reply({ ok: false, error: errorText(error) }),
    );
  return true;
});

chrome.runtime.onInstalled.addListener((details) => {
  void changed();
  void scheduleUpdates();
  if (details.reason === "install")
    void chrome.tabs.create({ url: chrome.runtime.getURL("setup.html") });
});
chrome.runtime.onStartup.addListener(() => void changed());

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "updates") void checkUpdates().then(changed);
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const id = String(info.menuItemId);
  if (!id.startsWith("sb-run:") || tab?.id === undefined) return;
  void allBoosts().then((boosts) => {
    const boost = boosts.find((b) => b.id === id.slice(7));
    if (boost) void runOnce(boost, tab.id as number, info.frameId ?? 0);
  });
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (tab?.id === undefined) return;
  const kind = command === "zap" ? "picker.zap" : "chip.open";
  void chrome.tabs.sendMessage(tab.id, { kind }, { frameId: 0 }).catch(() => undefined);
});

// Settings can change from any page: keep the update schedule in line.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) void scheduleUpdates();
});
