// Close tabs an agent opened once nobody has touched them for a while. Only tabs the agent
// created are tracked; user tabs and tabs the user pins are never closed. A tab is touched when
// an agent sends it a command or the user switches to it.
import { isAgentGroupId } from "./native-browser-groups.js";
import { onEngineInstall } from "./native-engine-install.js";

type Tracked = { touched: number };

const STORAGE_KEY = "aeon-agent-tab-cleanup";
const ALARM = "aeon-agent-tab-cleanup";
const DEFAULT_IDLE_MINUTES = 10;

const tracked = new Map<number, Tracked>();
const guarded = new Set<number>();
const grouped = new Set<number>();
let restored: Promise<void> | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

export function trackAgentTab(tabId: number): void {
  tracked.set(tabId, { touched: Date.now() });
  save();
}

export function touchAgentTab(tabId: number): void {
  const entry = tracked.get(tabId);
  if (!entry) return;
  entry.touched = Date.now();
  save();
}

export function forgetAgentTab(tabId: number): void {
  if (tracked.delete(tabId)) save();
  grouped.delete(tabId);
}

/** Marks a tab as placed in an agent group, so a later move out of it can hand the tab to the user. */
export function markAgentTabGrouped(tabId: number): void {
  grouped.add(tabId);
}

/** Keep a tab open while a hand-off, recording or other user-visible work owns it. */
export function guardAgentTab(tabId: number, guard: boolean): void {
  if (guard) guarded.add(tabId);
  else guarded.delete(tabId);
}

export function isAgentTab(tabId: number): boolean {
  return tracked.has(tabId);
}

export async function cleanupAgentTabs(options: { minutes?: number } = {}): Promise<number[]> {
  await restore();
  const minutes = options.minutes ?? DEFAULT_IDLE_MINUTES;
  const now = Date.now();
  const focused = await chrome.windows.getLastFocused().catch(() => undefined);
  const closed: number[] = [];
  for (const [tabId, entry] of Array.from(tracked)) {
    if (now - entry.touched < minutes * 60_000) continue;
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (!tab) {
      tracked.delete(tabId);
      continue;
    }
    if (tab.pinned) {
      tracked.delete(tabId);
      continue;
    }
    if (tab.active && tab.windowId === focused?.id && focused?.focused) continue;
    if (tab.audible || guarded.has(tabId)) continue;
    const removed = await chrome.tabs.remove(tabId).then(
      () => true,
      () => false,
    );
    tracked.delete(tabId);
    if (removed) closed.push(tabId);
  }
  save();
  return closed;
}

function restore(): Promise<void> {
  restored ??= chrome.storage.local.get(STORAGE_KEY).then((stored) => {
    const saved = (stored[STORAGE_KEY] ?? {}) as Record<string, Tracked>;
    for (const [tabId, entry] of Object.entries(saved))
      if (!tracked.has(Number(tabId))) tracked.set(Number(tabId), entry);
  });
  return restored;
}

function save(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void chrome.storage.local
      .set({ [STORAGE_KEY]: Object.fromEntries(tracked) })
      .catch(() => undefined);
  }, 500);
}

onEngineInstall(() => {
  chrome.runtime.onStartup.addListener(() => {
    tracked.clear();
    void chrome.storage.local.remove(STORAGE_KEY);
  });
  chrome.tabs.onActivated.addListener(({ tabId }) => touchAgentTab(tabId));
  chrome.tabs.onRemoved.addListener((tabId) => forgetAgentTab(tabId));
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (change.pinned) forgetAgentTab(tabId);
    if (change.groupId === undefined) return;
    if (change.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE && grouped.has(tabId)) {
      forgetAgentTab(tabId);
      return;
    }
    if (change.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE && !isAgentGroupId(change.groupId))
      forgetAgentTab(tabId);
  });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM) void cleanupAgentTabs();
  });
  void chrome.alarms.create(ALARM, { periodInMinutes: 1 });
});
