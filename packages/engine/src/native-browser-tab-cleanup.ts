// Close tabs an agent opened once they are no longer needed. Only tabs the agent created are
// tracked; user tabs and tabs the user pins are never closed. When a run ends, its chat keeps
// only the tab it used last and tabs the user switched to; during a run a chat keeps at most
// MAX_CHAT_TABS; any left over close after DEFAULT_IDLE_MINUTES untouched. A tab is touched when
// an agent sends it a command or the user switches to it. Tabs held for a hand-off or recording,
// playing audio, or in front of the user stay open; page.keep() hands a tab to the user for good.
import { isAgentGroupId } from "./native-browser-groups.js";
import { onEngineInstall } from "./native-engine-install.js";

type Tracked = { touched: number; chatId?: string; seen?: boolean };

const STORAGE_KEY = "aeon-agent-tab-cleanup";
const ALARM = "aeon-agent-tab-cleanup";
const DEFAULT_IDLE_MINUTES = 10;
const MAX_CHAT_TABS = 6;
// A tab used this recently is still part of the work (parallel reads, a page it will return to).
const BUSY_MS = 30_000;

const tracked = new Map<number, Tracked>();
const guarded = new Set<number>();
const grouped = new Set<number>();
let restored: Promise<void> | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

export function trackAgentTab(tabId: number, chatId?: string): void {
  tracked.set(tabId, { touched: Date.now(), ...(chatId ? { chatId } : {}) });
  save();
  if (chatId) void capChatTabs(chatId);
}

export function touchAgentTab(tabId: number): void {
  const entry = tracked.get(tabId);
  if (!entry) return;
  entry.touched = Date.now();
  save();
}

/** The user switched to the tab: they may want it after the run, so the run's tidy-up keeps it. */
function seeAgentTab(tabId: number): void {
  const entry = tracked.get(tabId);
  if (entry) entry.seen = true;
  touchAgentTab(tabId);
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
  const idle = (options.minutes ?? DEFAULT_IDLE_MINUTES) * 60_000;
  const now = Date.now();
  return closeTabs(
    [...tracked].filter(([, entry]) => now - entry.touched >= idle),
    false,
  );
}

/** After a chat's run: close its tabs except the one it used last and ones the user looked at. */
export async function tidyChatTabs(chatId: string): Promise<number[]> {
  await restore();
  return closeTabs(chatTabs(chatId).slice(1), true);
}

/** During a run: past MAX_CHAT_TABS, close the chat's least recently used tabs. */
async function capChatTabs(chatId: string): Promise<number[]> {
  const now = Date.now();
  const extra = chatTabs(chatId)
    .slice(MAX_CHAT_TABS)
    .filter(([, entry]) => now - entry.touched >= BUSY_MS);
  return extra.length ? closeTabs(extra, true) : [];
}

/** A chat's tracked tabs, most recently used first. */
function chatTabs(chatId: string): [number, Tracked][] {
  return [...tracked]
    .filter(([, entry]) => entry.chatId === chatId)
    .sort((a, b) => b[1].touched - a[1].touched);
}

async function closeTabs(entries: [number, Tracked][], keepSeen: boolean): Promise<number[]> {
  const focused = await chrome.windows.getLastFocused().catch(() => undefined);
  const closed: number[] = [];
  for (const [tabId, entry] of entries) {
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (!tab || tab.pinned) {
      tracked.delete(tabId);
      continue;
    }
    if (!closable(tab, entry, focused, keepSeen)) continue;
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

function closable(
  tab: chrome.tabs.Tab,
  entry: Tracked,
  focused: chrome.windows.Window | undefined,
  keepSeen: boolean,
): boolean {
  if (tab.active && tab.windowId === focused?.id && focused?.focused) return false;
  if (tab.audible || guarded.has(tab.id ?? -1)) return false;
  return !(keepSeen && entry.seen);
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
  chrome.tabs.onActivated.addListener(({ tabId }) => seeAgentTab(tabId));
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
