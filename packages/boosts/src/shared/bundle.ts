import { strFromU8, strToU8, unzipSync, zipSync, deflateSync, inflateSync } from "fflate";
import { boostFromSource } from "./userscript.js";
import type { Boost, Settings, SiteRule } from "./types.js";

// Backups and sharing: a JSON bundle, a ZIP (scripts and styles as their own files), or a short
// text code to paste.

export interface Bundle {
  format: "site-boosts";
  version: 1;
  exported: string;
  boosts: Boost[];
  /** Stored values per boost id. */
  values?: Record<string, Record<string, unknown>>;
  settings?: Partial<Settings>;
}

const RULE_TYPES = new Set(["domain", "prefix", "url", "regex", "match", "glob", "all"]);

export function newId(): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return [...bytes]
    .map((b) => b.toString(36).padStart(2, "0"))
    .join("")
    .slice(0, 14);
}

function cleanSites(value: unknown): SiteRule[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((rule): SiteRule | undefined => {
      if (typeof rule === "string")
        return rule.includes("/") || rule.includes("*")
          ? { type: "match", value: rule }
          : { type: "domain", value: rule };
      const r = rule as { type?: string; value?: unknown };
      if (!r || !RULE_TYPES.has(String(r.type))) return undefined;
      return { type: r.type, value: typeof r.value === "string" ? r.value : undefined } as SiteRule;
    })
    .filter((rule): rule is SiteRule => Boolean(rule));
}

const asArray = <T>(value: unknown): T[] | undefined =>
  Array.isArray(value) ? (value as T[]) : undefined;
const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value ? value : undefined;

/** A boost from untrusted JSON (a file, a share code, a model's answer), with defaults filled in. */
export function normalizeBoost(input: unknown, now = Date.now()): Boost {
  const raw = (input ?? {}) as Record<string, unknown>;
  return { ...identity(raw, now), ...parts(raw) };
}

const asNumber = (value: unknown, fallback: number): number =>
  typeof value === "number" ? value : fallback;

function identity(
  raw: Record<string, unknown>,
  now: number,
): Omit<Boost, keyof ReturnType<typeof parts>> {
  const sites = cleanSites(raw.sites);
  return {
    id: asString(raw.id) ?? newId(),
    name: asString(raw.name) ?? "Untitled boost",
    description: asString(raw.description),
    kind: raw.kind === "userscript" || raw.kind === "userstyle" ? raw.kind : "boost",
    enabled: raw.enabled !== false,
    sites: sites.length ? sites : [{ type: "all" }],
    excludes: cleanSites(raw.excludes),
    order: asNumber(raw.order, 0),
    tags: (asArray<unknown>(raw.tags) ?? []).filter((t): t is string => typeof t === "string"),
    created: asNumber(raw.created, now),
    updated: asNumber(raw.updated, now),
    autoRepair: raw.autoRepair === false ? false : undefined,
    origin: raw.origin as Boost["origin"],
    chat: asArray(raw.chat),
  };
}

function parts(
  raw: Record<string, unknown>,
): Pick<
  Boost,
  | "css"
  | "sections"
  | "zaps"
  | "look"
  | "actions"
  | "network"
  | "html"
  | "js"
  | "jsWorld"
  | "runAt"
  | "allFrames"
  | "source"
  | "meta"
  | "requires"
  | "resources"
  | "varValues"
> {
  return {
    css: asString(raw.css),
    sections: asArray(raw.sections),
    zaps: asArray(raw.zaps),
    look: raw.look && typeof raw.look === "object" ? (raw.look as Boost["look"]) : undefined,
    actions: asArray(raw.actions),
    network: asArray(raw.network),
    html: asArray(raw.html),
    js: asString(raw.js),
    jsWorld: raw.jsWorld === "isolated" ? "isolated" : raw.js ? "page" : undefined,
    runAt: asString(raw.runAt) as Boost["runAt"],
    allFrames: raw.allFrames === true,
    source: asString(raw.source),
    meta: raw.meta as Boost["meta"],
    requires: asArray(raw.requires),
    resources: raw.resources as Boost["resources"],
    varValues: raw.varValues as Boost["varValues"],
  };
}

/** What leaves the machine when sharing: no conversation, health or stored values. */
export function forSharing(boost: Boost): Boost {
  const copy: Boost = { ...boost };
  delete copy.chat;
  return copy;
}

export function toBundle(boosts: Boost[], extra: Pick<Bundle, "values" | "settings"> = {}): Bundle {
  return {
    format: "site-boosts",
    version: 1,
    exported: new Date().toISOString(),
    boosts,
    ...extra,
  };
}

/** Reads a bundle, a single boost, or userscript/userstyle source. */
export function parseBundle(text: string): Bundle {
  const trimmed = text.trim();
  if (trimmed.startsWith("site-boosts:")) return parseShareCode(trimmed);
  if (/==User(Script|Style)==/.test(trimmed) && !trimmed.startsWith("{"))
    return toBundle([boostFromSource(trimmed, newId())]);
  const data = JSON.parse(trimmed) as Partial<Bundle> & Record<string, unknown>;
  if (data.format === "site-boosts" && Array.isArray(data.boosts))
    return {
      ...toBundle(data.boosts.map((b) => normalizeBoost(b))),
      values: data.values,
      settings: data.settings,
    };
  return toBundle([normalizeBoost(data)]);
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** A compact code to paste anywhere: "site-boosts:" and compressed JSON. */
export function shareCode(boosts: Boost[]): string {
  const json = JSON.stringify(toBundle(boosts.map(forSharing)));
  return "site-boosts:" + base64url(deflateSync(strToU8(json), { level: 9 }));
}

export function parseShareCode(code: string): Bundle {
  const json = strFromU8(inflateSync(fromBase64url(code.trim().replace(/^site-boosts:/, ""))));
  return parseBundle(json);
}

const fileName = (name: string): string =>
  name
    .replace(/[^\w .-]+/g, "_")
    .trim()
    .slice(0, 80) || "boost";

/** A ZIP with each script and style as its own file, and everything in site-boosts.json. */
export function toZip(bundle: Bundle): Uint8Array {
  const files: Record<string, Uint8Array> = {
    "site-boosts.json": strToU8(JSON.stringify(bundle, null, 2)),
  };
  const used = new Set<string>();
  for (const boost of bundle.boosts) {
    const extension =
      boost.kind === "userscript"
        ? ".user.js"
        : boost.kind === "userstyle"
          ? ".user.css"
          : ".boost.json";
    let name = fileName(boost.name) + extension;
    for (let n = 2; used.has(name); n++) name = `${fileName(boost.name)} (${n})${extension}`;
    used.add(name);
    files[name] = strToU8(
      boost.kind === "boost" ? JSON.stringify(forSharing(boost), null, 2) : (boost.source ?? ""),
    );
  }
  return zipSync(files, { level: 6 });
}

export function fromZip(bytes: Uint8Array): Bundle {
  const files = unzipSync(bytes);
  const all = files["site-boosts.json"];
  if (all) return parseBundle(strFromU8(all));
  const boosts: Boost[] = [];
  for (const [name, data] of Object.entries(files)) {
    if (/\.user\.(js|css)$/i.test(name)) boosts.push(boostFromSource(strFromU8(data), newId()));
    else if (/\.json$/i.test(name)) boosts.push(...parseBundle(strFromU8(data)).boosts);
  }
  return toBundle(boosts);
}
