import { engineConfig } from "./engine-config.js";
import { ownerTitle as storedOwnerTitle } from "./native-browser-owner.js";
import { onEngineInstall } from "./native-engine-install.js";

// Tabs an agent opens are kept together in one tab group per chat, per window, so the user can
// see, collapse or close an agent's work at once. Grouping is presentation only: it never fails a
// step. The owner→group map is persisted in session storage because the MV3 worker sleeps; when
// it is gone, the invisible owner marker in the group title lets a later tab rejoin its group
// instead of making one more "Aeon" group.
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
type Color = (typeof COLORS)[number];
interface GroupRecord {
  windowId: number;
  groupId: number;
  title: string;
  color: Color;
}
const STORAGE_KEY = "browserkit-agent-groups";
const MARK = "\u2063";
const MAX_TITLE = 24;
const groups = new Map<string, Map<number, GroupRecord>>();
// Tabs opened together (Promise.all) would each see "no group yet" and make their own; grouping
// for one owner runs in order so the first creates the group and the rest join it.
const pending = new Map<string, Promise<void>>();
let restored: Promise<void> | undefined;
let ready = false;

export function groupAgentTab(
  tabId: number,
  windowId: number,
  owner: string,
  ownerTitle?: string,
): Promise<void> {
  if (!engineConfig.tabGroups || typeof chrome.tabGroups === "undefined") return Promise.resolve();
  const run = (pending.get(owner) ?? Promise.resolve()).then(async () => {
    await restore();
    const prior = groups.get(owner)?.get(windowId)?.title;
    const inherited = prior?.includes(MARK) ? prior.slice(0, prior.indexOf(MARK)) : prior;
    await joinGroup(tabId, windowId, owner, ownerTitle ?? storedOwnerTitle(owner) ?? inherited);
  });
  pending.set(owner, run);
  void run.finally(() => {
    if (pending.get(owner) === run) pending.delete(owner);
  });
  return run;
}

async function joinGroup(
  tabId: number,
  windowId: number,
  owner: string,
  ownerTitle: string | undefined,
): Promise<void> {
  try {
    const title = groupTitle(owner, ownerTitle);
    const existing = await reusableGroup(owner, windowId, title);
    const groupId = await chrome.tabs.group(
      existing === undefined
        ? { tabIds: tabId, createProperties: { windowId } }
        : { tabIds: tabId, groupId: existing },
    );
    const record: GroupRecord = {
      windowId,
      groupId,
      title,
      color: COLORS[hash(owner) % COLORS.length] ?? "blue",
    };
    setRecord(owner, record);
    await chrome.tabGroups.update(groupId, { title, color: record.color });
    await save();
  } catch {
    // A dragged-out tab, a closed window or a browser without groups: leave the tab ungrouped.
  }
}

async function reusableGroup(
  owner: string,
  windowId: number,
  title: string,
): Promise<number | undefined> {
  const grouped = groups.get(owner)?.get(windowId);
  if (grouped && (await chrome.tabGroups.get(grouped.groupId).catch(() => undefined))) {
    return grouped.groupId;
  }
  if (grouped) groups.get(owner)?.delete(windowId);
  // The map may be gone: find the group by the marker every title carries.
  const match = await findGroup(owner, windowId, title);
  if (match === undefined) return undefined;
  setRecord(owner, { windowId, groupId: match, title, color: colorFor(owner) });
  return match;
}

async function findGroup(
  owner: string,
  windowId: number,
  title: string,
): Promise<number | undefined> {
  if (typeof chrome.tabGroups.query !== "function") return undefined;
  const mark = marker(owner);
  if (!mark) return undefined;
  const legacy = title.slice(0, title.indexOf(MARK));
  const all = await chrome.tabGroups.query({ windowId }).catch(() => []);
  return all.find((group) => group.title?.endsWith(mark) || group.title === legacy)?.id;
}

function setRecord(owner: string, record: GroupRecord): void {
  let byWindow = groups.get(owner);
  if (!byWindow) groups.set(owner, (byWindow = new Map()));
  byWindow.set(record.windowId, record);
}

function groupTitle(owner: string, ownerTitle: string | undefined): string {
  const configured = engineConfig.tabGroupTitle(owner, ownerTitle);
  const visible = configured.replace(/\s+/g, " ").trim() || "Agent";
  const short = visible.length > MAX_TITLE ? visible.slice(0, MAX_TITLE - 1) + "…" : visible;
  return short + MARK + owner.slice(0, 8);
}

function marker(owner: string): string | undefined {
  return MARK + owner.slice(0, 8);
}
function colorFor(owner: string): Color {
  return COLORS[hash(owner) % COLORS.length] ?? "blue";
}

/** After a run: keep its tabs but get the group out of the way. */
export async function collapseAgentGroups(owner: string): Promise<void> {
  await restore();
  const byWindow = groups.get(owner);
  if (!byWindow) return;
  for (const record of [...byWindow.values()]) {
    const updated = await chrome.tabGroups
      .update(record.groupId, { collapsed: true })
      .catch(() => undefined);
    if (!updated) byWindow.delete(record.windowId);
  }
  await save();
}

/** Whether a Chrome tab group belongs to an agent session. */
export function isAgentGroupId(groupId: number): boolean {
  return [...groups.values()].some((byWindow) =>
    [...byWindow.values()].some((record) => record.groupId === groupId),
  );
}

/** Whether the persisted owner→group map has loaded (so an unknown group is not just missing). */
export function agentGroupsReady(): boolean {
  return ready;
}

function restore(): Promise<void> {
  restored ??= read().then((records) => {
    for (const record of records) setRecord(record.owner, record);
    ready = true;
  });
  return restored;
}

async function read(): Promise<(GroupRecord & { owner: string })[]> {
  if (!chrome.storage?.session) return [];
  const all = (await chrome.storage.session.get(STORAGE_KEY).catch(() => ({}))) as Record<
    string,
    unknown
  >;
  const stored = all[STORAGE_KEY];
  if (!Array.isArray(stored)) return [];
  return stored.filter(
    (item): item is GroupRecord & { owner: string } =>
      typeof item?.owner === "string" &&
      Number.isSafeInteger(item.windowId) &&
      Number.isSafeInteger(item.groupId) &&
      typeof item.title === "string" &&
      COLORS.includes(item.color),
  );
}

let writing = Promise.resolve();
function save(): Promise<void> {
  if (!chrome.storage?.session) return Promise.resolve();
  const records = [...groups].flatMap(([owner, byWindow]) =>
    [...byWindow.values()].map((record) => ({ owner, ...record })),
  );
  writing = writing
    .catch(() => undefined)
    .then(() => chrome.storage.session.set({ [STORAGE_KEY]: records }))
    .catch(() => undefined);
  return writing;
}

function hash(text: string): number {
  let value = 0;
  for (const char of text) value = (value * 31 + char.charCodeAt(0)) >>> 0;
  return value;
}

onEngineInstall(() => {
  void restore();
  chrome.tabGroups?.onRemoved?.addListener((group) => {
    for (const byWindow of groups.values())
      for (const [windowId, record] of byWindow)
        if (record.groupId === group.id) byWindow.delete(windowId);
    void save();
  });
});
