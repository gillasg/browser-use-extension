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

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !cache) return;
  for (const [key, change] of Object.entries(changes)) {
    if (!key.startsWith("b:")) continue;
    if (change.newValue) cache.set(key.slice(2), change.newValue as Boost);
    else cache.delete(key.slice(2));
  }
});

async function load(): Promise<Map<string, Boost>> {
  if (cache) return cache;
  const all = await chrome.storage.local.get(null);
  cache = new Map(
    Object.entries(all)
      .filter(([key]) => key.startsWith("b:"))
      .map(([key, value]) => [key.slice(2), value as Boost]),
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
    [`b:${saved.id}`]: saved,
    [`r:${saved.id}`]: revisions.slice(0, MAX_REVISIONS),
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
  await chrome.storage.local.set({ [`b:${id}`]: saved });
  return saved;
}

export async function deleteBoost(id: string): Promise<void> {
  (await load()).delete(id);
  await chrome.storage.local.remove([`b:${id}`, `r:${id}`, `h:${id}`, `v:${id}`]);
}

export async function getRevisions(id: string): Promise<Revision[]> {
  const stored = await chrome.storage.local.get(`r:${id}`);
  return (stored[`r:${id}`] as Revision[] | undefined) ?? [];
}

export async function getHealth(id: string): Promise<Health> {
  const stored = await chrome.storage.local.get(`h:${id}`);
  return (stored[`h:${id}`] as Health | undefined) ?? { status: "unknown", misses: 0 };
}

export async function setHealth(id: string, health: Health): Promise<void> {
  await chrome.storage.local.set({ [`h:${id}`]: health });
}

export async function allHealth(): Promise<Record<string, Health>> {
  const all = await chrome.storage.local.get(null);
  return Object.fromEntries(
    Object.entries(all)
      .filter(([key]) => key.startsWith("h:"))
      .map(([key, value]) => [key.slice(2), value as Health]),
  );
}

export async function getValues(id: string): Promise<Record<string, unknown>> {
  const stored = await chrome.storage.local.get(`v:${id}`);
  return (stored[`v:${id}`] as Record<string, unknown> | undefined) ?? {};
}

export async function setValues(id: string, values: Record<string, unknown>): Promise<void> {
  await chrome.storage.local.set({ [`v:${id}`]: values });
}

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...((stored.settings as Partial<Settings> | undefined) ?? {}) };
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const settings = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings });
  return settings;
}

export interface SiteState {
  /** Nothing runs on this site. */
  off?: boolean;
  /** These boosts are off on this site only. */
  boostsOff?: string[];
}

export async function getSites(): Promise<Record<string, SiteState>> {
  const stored = await chrome.storage.local.get("sites");
  return (stored.sites as Record<string, SiteState> | undefined) ?? {};
}

export async function setSite(host: string, state: SiteState): Promise<void> {
  const sites = await getSites();
  if (!state.off && !state.boostsOff?.length) delete sites[host];
  else sites[host] = state;
  await chrome.storage.local.set({ sites });
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
    void chrome.storage.local.get("log").then((stored) => {
      const entries = [...batch.reverse(), ...((stored.log as LogEntry[] | undefined) ?? [])];
      return chrome.storage.local.set({ log: entries.slice(0, MAX_LOG) });
    });
  }, 200);
}

export async function getLog(): Promise<LogEntry[]> {
  const stored = await chrome.storage.local.get("log");
  return (stored.log as LogEntry[] | undefined) ?? [];
}

export async function clearLog(): Promise<void> {
  await chrome.storage.local.set({ log: [] });
}
