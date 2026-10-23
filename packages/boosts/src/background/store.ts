import {
  DEFAULT_SETTINGS,
  type Boost,
  type Health,
  type Revision,
  type Settings,
} from "../shared/types.js";

// Everything lives in chrome.storage.local, one key per boost so large scripts stay cheap to change:
//   b:<id> boost   r:<id> revisions   h:<id> health   v:<id> stored values
//   settings   sites (per-site switches)   log (the error console)

const MAX_REVISIONS = 50;
const MAX_LOG = 300;

let cache: Map<string, Boost> | undefined;

/** Keys start with this inside another extension (see embed/), so they never meet its own. */
let prefix = "";
export function setStorePrefix(value: string): void {
  prefix = value;
  cache = undefined;
}
export const storeKey = (name: string): string => prefix + name;
const key = storeKey;

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !cache) return;
  for (const [name, change] of Object.entries(changes)) {
    if (!name.startsWith(key("b:"))) continue;
    const id = name.slice(key("b:").length);
    if (change.newValue) cache.set(id, change.newValue as Boost);
    else cache.delete(id);
  }
});

async function load(): Promise<Map<string, Boost>> {
  if (cache) return cache;
  const all = await chrome.storage.local.get(null);
  cache = new Map(
    Object.entries(all)
      .filter(([name]) => name.startsWith(key("b:")))
      .map(([name, value]) => [name.slice(key("b:").length), value as Boost]),
  );
  return cache;
}

export async function allBoosts(): Promise<Boost[]> {
  return [...(await load()).values()].sort((a, b) => a.order - b.order || a.created - b.created);
}

export async function getBoost(id: string): Promise<Boost | undefined> {
  return (await load()).get(id);
}

/** Saves a boost and records a revision. */
export async function putBoost(boost: Boost, by: Revision["by"], note?: string): Promise<Boost> {
  const map = await load();
  const saved = { ...boost, updated: Date.now() };
  map.set(saved.id, saved);
  const revisions = await getRevisions(saved.id);
  revisions.unshift({ at: saved.updated, by, note, boost: saved });
  await chrome.storage.local.set({
    [key(`b:${saved.id}`)]: saved,
    [key(`r:${saved.id}`)]: revisions.slice(0, MAX_REVISIONS),
  });
  return saved;
}

/** Saves a change that is not worth a revision (switching on or off, reordering). */
export async function patchBoost(id: string, patch: Partial<Boost>): Promise<Boost | undefined> {
  const map = await load();
  const boost = map.get(id);
  if (!boost) return undefined;
  const saved = { ...boost, ...patch };
  map.set(id, saved);
  await chrome.storage.local.set({ [key(`b:${id}`)]: saved });
  return saved;
}

export async function deleteBoost(id: string): Promise<void> {
  (await load()).delete(id);
  await chrome.storage.local.remove(["b:", "r:", "h:", "v:"].map((p) => key(p + id)));
}

export async function getRevisions(id: string): Promise<Revision[]> {
  const stored = await chrome.storage.local.get(key(`r:${id}`));
  return (stored[key(`r:${id}`)] as Revision[] | undefined) ?? [];
}

export async function getHealth(id: string): Promise<Health> {
  const stored = await chrome.storage.local.get(key(`h:${id}`));
  return (stored[key(`h:${id}`)] as Health | undefined) ?? { status: "unknown", misses: 0 };
}

export async function setHealth(id: string, health: Health): Promise<void> {
  await chrome.storage.local.set({ [key(`h:${id}`)]: health });
}

export async function allHealth(): Promise<Record<string, Health>> {
  const all = await chrome.storage.local.get(null);
  return Object.fromEntries(
    Object.entries(all)
      .filter(([name]) => name.startsWith(key("h:")))
      .map(([name, value]) => [name.slice(key("h:").length), value as Health]),
  );
}

export async function getValues(id: string): Promise<Record<string, unknown>> {
  const stored = await chrome.storage.local.get(key(`v:${id}`));
  return (stored[key(`v:${id}`)] as Record<string, unknown> | undefined) ?? {};
}

export async function setValues(id: string, values: Record<string, unknown>): Promise<void> {
  await chrome.storage.local.set({ [key(`v:${id}`)]: values });
}

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(key("settings"));
  return {
    ...DEFAULT_SETTINGS,
    ...((stored[key("settings")] as Partial<Settings> | undefined) ?? {}),
  };
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const settings = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ [key("settings")]: settings });
  return settings;
}

export interface SiteState {
  /** Nothing runs on this site. */
  off?: boolean;
  /** These boosts are off on this site only. */
  boostsOff?: string[];
}

export async function getSites(): Promise<Record<string, SiteState>> {
  const stored = await chrome.storage.local.get(key("sites"));
  return (stored[key("sites")] as Record<string, SiteState> | undefined) ?? {};
}

export async function setSite(host: string, state: SiteState): Promise<void> {
  const sites = await getSites();
  if (!state.off && !state.boostsOff?.length) delete sites[host];
  else sites[host] = state;
  await chrome.storage.local.set({ [key("sites")]: sites });
}

export interface LogEntry {
  at: number;
  level: "error" | "warn" | "info";
  boostId?: string;
  url?: string;
  message: string;
}

let logQueue: LogEntry[] = [];
let logTimer: ReturnType<typeof setTimeout> | undefined;

/** The error console. Writes are batched. */
export function log(entry: Omit<LogEntry, "at">): void {
  logQueue.push({ at: Date.now(), ...entry });
  logTimer ??= setTimeout(() => {
    logTimer = undefined;
    const batch = logQueue;
    logQueue = [];
    void chrome.storage.local.get(key("log")).then((stored) => {
      const entries = [
        ...batch.reverse(),
        ...((stored[key("log")] as LogEntry[] | undefined) ?? []),
      ];
      return chrome.storage.local.set({ [key("log")]: entries.slice(0, MAX_LOG) });
    });
  }, 200);
}

export async function getLog(): Promise<LogEntry[]> {
  const stored = await chrome.storage.local.get(key("log"));
  return (stored[key("log")] as LogEntry[] | undefined) ?? [];
}

export async function clearLog(): Promise<void> {
  await chrome.storage.local.set({ [key("log")]: [] });
}
