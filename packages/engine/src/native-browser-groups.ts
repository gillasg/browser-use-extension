import { engineConfig } from "./engine-config.js";

// Tabs an agent opens are kept together in one tab group per session, so the user can see,
// collapse or close an agent's work at once. Grouping is presentation only: it never fails a step.
const COLORS = [
  "blue",
  "purple",
  "cyan",
  "green",
  "orange",
  "pink",
  "yellow",
  "red",
  "grey",
] as const;
const groups = new Map<string, number>();
// Tabs opened together (Promise.all) would each see "no group yet" and make their own; grouping
// for one owner runs in order so the first creates the group and the rest join it.
const pending = new Map<string, Promise<void>>();

export function groupAgentTab(tabId: number, windowId: number, owner: string): Promise<void> {
  if (!engineConfig.tabGroups || typeof chrome.tabGroups === "undefined") return Promise.resolve();
  const run = (pending.get(owner) ?? Promise.resolve()).then(() =>
    joinGroup(tabId, windowId, owner),
  );
  pending.set(owner, run);
  void run.finally(() => {
    if (pending.get(owner) === run) pending.delete(owner);
  });
  return run;
}

async function joinGroup(tabId: number, windowId: number, owner: string): Promise<void> {
  try {
    const existing = await reusableGroup(owner, windowId);
    const groupId = await chrome.tabs.group(
      existing === undefined
        ? { tabIds: tabId, createProperties: { windowId } }
        : { tabIds: tabId, groupId: existing },
    );
    if (existing === groupId) return;
    groups.set(owner, groupId);
    await chrome.tabGroups.update(groupId, {
      title: engineConfig.tabGroupTitle(owner),
      color: COLORS[hash(owner) % COLORS.length] ?? "blue",
    });
  } catch {
    // A dragged-out tab, a closed window or a browser without groups: leave the tab ungrouped.
  }
}

async function reusableGroup(owner: string, windowId: number): Promise<number | undefined> {
  const groupId = groups.get(owner);
  if (groupId === undefined) return undefined;
  const group = await chrome.tabGroups.get(groupId).catch(() => undefined);
  return group?.windowId === windowId ? groupId : undefined;
}

function hash(text: string): number {
  let value = 0;
  for (const char of text) value = (value * 31 + char.charCodeAt(0)) >>> 0;
  return value;
}
