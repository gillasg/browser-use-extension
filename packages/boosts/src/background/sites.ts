import { newId } from "../shared/bundle.js";
import { boostMatches, ruleMatches, siteRuleFor } from "../shared/match.js";
import { TRACKER_DOMAINS } from "../shared/network.js";
import type { Boost, Look, PagePlan, Zap } from "../shared/types.js";
import { userScriptsAvailable } from "./scripts.js";
import {
  allBoosts,
  allHealth,
  deleteBoost,
  getRevisions,
  getSettings,
  getSites,
  putBoost,
  setSite,
} from "./store.js";

// What applies to a page, per-site switches, and the boosts the toolbar makes for a site
// (hidden elements, look, ad and tracker blocking).

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function blocked(url: string, blocklist: string[]): boolean {
  return blocklist.some((entry) =>
    ruleMatches(
      entry.includes("/") || entry.includes("*")
        ? { type: "glob", value: entry }
        : { type: "domain", value: entry },
      url,
    ),
  );
}

/** Everything the content script needs for one URL. */
export async function planFor(url: string, top = true): Promise<PagePlan> {
  const settings = await getSettings();
  const host = hostOf(url);
  const site = (await getSites())[host];
  const boosts = (await allBoosts()).filter(
    (b) => boostMatches(b, url) && (top || b.allFrames || b.kind === "userstyle"),
  );
  const health = await allHealth();
  const active = boosts
    .filter((b) => b.enabled && !site?.boostsOff?.includes(b.id))
    .map((b) => b.id);
  return {
    boosts,
    active,
    siteOff: site?.boostsOff ?? [],
    health: Object.fromEntries(
      boosts.map((b) => [b.id, health[b.id] ?? { status: "unknown", misses: 0 }]),
    ),
    showChip: settings.showChip,
    siteDisabled: Boolean(site?.off) || blocked(url, settings.blocklist),
    paused: settings.paused,
    setupNeeded: boosts.some((b) => b.enabled && Boolean(b.js)) && !(await userScriptsAvailable()),
    host,
  };
}

export async function toggleSite(host: string, on: boolean): Promise<void> {
  const sites = await getSites();
  await setSite(host, { ...sites[host], off: !on });
}

export async function toggleBoostOnSite(host: string, id: string, on: boolean): Promise<void> {
  const sites = await getSites();
  const current = new Set(sites[host]?.boostsOff ?? []);
  if (on) current.delete(id);
  else current.add(id);
  await setSite(host, { ...sites[host], boostsOff: [...current] });
}

/** The boost a site keeps for one kind of toolbar change. */
async function siteBoost(host: string, tag: string, name: string): Promise<Boost> {
  const existing = (await allBoosts()).find(
    (b) =>
      b.tags.includes(tag) &&
      b.sites.length === 1 &&
      b.sites[0]?.type === "domain" &&
      b.sites[0].value === host,
  );
  if (existing) return existing;
  const now = Date.now();
  return {
    id: newId(),
    name,
    kind: "boost",
    enabled: true,
    sites: [siteRuleFor(`https://${host}/`)],
    order: 0,
    tags: [tag],
    created: now,
    updated: now,
  };
}

/** Adds a zap to the site's "Hidden on" boost. Returns its id. */
export async function addZap(url: string, zap: Zap): Promise<string> {
  const host = hostOf(url);
  const boost = await siteBoost(host, "zaps", `Hidden on ${host}`);
  const zaps = [
    ...(boost.zaps ?? []).filter((z) => z.selector !== zap.selector || z.contains !== zap.contains),
    zap,
  ];
  const saved = await putBoost({ ...boost, enabled: true, zaps }, "user", `Hid ${zap.selector}`);
  return saved.id;
}

export async function getLook(host: string): Promise<Look | undefined> {
  return (await allBoosts()).find((b) => b.tags.includes("look") && b.sites[0]?.value === host)
    ?.look;
}

export async function setLook(host: string, look: Look | undefined): Promise<Boost | undefined> {
  const boost = await siteBoost(host, "look", `Look of ${host}`);
  const empty =
    !look || Object.values(look).every((v) => v === undefined || v === false || v === "");
  if (empty) {
    if ((await allBoosts()).some((b) => b.id === boost.id)) await deleteBoost(boost.id);
    return undefined;
  }
  return putBoost({ ...boost, look }, "user", "Changed the look");
}

export type Preset = "trackers" | "autoplay";

const PRESETS: Record<Preset, (host: string) => Pick<Boost, "name" | "network" | "actions">> = {
  trackers: (host) => ({
    name: `Block ads and trackers on ${host}`,
    network: [{ action: "block", domains: TRACKER_DOMAINS, scope: "from-site" }],
  }),
  autoplay: (host) => ({ name: `No autoplay on ${host}`, actions: [{ do: "pauseMedia" }] }),
};

/** The one-switch boosts (ad and tracker blocking, no autoplay) that are on for a site. */
export async function presetsFor(host: string): Promise<Record<Preset, boolean>> {
  const boosts = await allBoosts();
  const on = (tag: Preset): boolean =>
    boosts.some((b) => b.tags.includes(tag) && b.enabled && b.sites[0]?.value === host);
  return { trackers: on("trackers"), autoplay: on("autoplay") };
}

export async function setPreset(host: string, preset: Preset, on: boolean): Promise<void> {
  const parts = PRESETS[preset](host);
  const boost = await siteBoost(host, preset, parts.name);
  if (!on) {
    if ((await allBoosts()).some((b) => b.id === boost.id)) await deleteBoost(boost.id);
    return;
  }
  await putBoost({ ...boost, ...parts, enabled: true }, "user", `Turned on: ${parts.name}`);
}

/** Goes back one revision; a boost with no earlier revision is removed. */
export async function undo(id: string): Promise<void> {
  const revisions = await getRevisions(id);
  const previous = revisions[1];
  if (!previous) return deleteBoost(id);
  await putBoost(previous.boost, "rollback", "Undid the last change");
}

export async function rollback(id: string, at: number): Promise<Boost> {
  const revision = (await getRevisions(id)).find((r) => r.at === at);
  if (!revision) throw new Error("That version is gone");
  return putBoost(
    revision.boost,
    "rollback",
    `Back to the version from ${new Date(at).toLocaleString()}`,
  );
}
