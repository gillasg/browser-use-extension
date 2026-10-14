import { newId } from "../shared/bundle.js";
import { unifiedDiff } from "../shared/diff.js";
import { reviewBoost, type Review } from "../shared/review.js";
import {
  boostFromSource,
  compareVersions,
  isUserStyle,
  parseUserScript,
  parseUserStyle,
} from "../shared/userscript.js";
import type { Boost } from "../shared/types.js";
import { allBoosts, getSettings, log, putBoost } from "./store.js";
import { compileStyle } from "./styles.js";

// Installing userscripts and userstyles from a URL or text: fetching @require and @resource
// (checking integrity hashes), recognising updates to installed ones, and checking for updates.

export interface Prepared {
  boost: Boost;
  review: Review;
  /** The installed boost this replaces. */
  existing?: { id: string; name: string; version?: string };
  diff?: string;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.text();
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

const ALGORITHMS: Record<string, string> = {
  sha256: "SHA-256",
  sha384: "SHA-384",
  sha512: "SHA-512",
  sha1: "SHA-1",
};

/** Checks a #sha256=<hex> or #sha256-<base64> suffix (several may be listed with commas). */
async function verify(url: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
  const hash = url.split("#")[1];
  if (!hash) return;
  for (const part of hash.split(/[,;]/)) {
    const parsed = /^(sha256|sha384|sha512|sha1)[=-](.+)$/i.exec(part.trim());
    if (!parsed) continue;
    const algorithm = ALGORITHMS[(parsed[1] as string).toLowerCase()] as string;
    const digest = new Uint8Array(await crypto.subtle.digest(algorithm, bytes));
    const expected = parsed[2] as string;
    const hex = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (expected.toLowerCase() !== hex && expected !== toBase64(digest))
      throw new Error(`${url.split("#")[0]} does not match its integrity hash`);
  }
}

async function fetchBytes(url: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; mime: string }> {
  const response = await fetch(url.split("#")[0] as string, { cache: "no-store" });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  await verify(url, bytes);
  return {
    bytes,
    mime: response.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream",
  };
}

/** Adds the code of each @require and the data of each @resource. */
async function withDependencies(boost: Boost, base: string | undefined): Promise<Boost> {
  const meta = boost.meta;
  if (!meta || boost.kind !== "userscript") return boost;
  const resolve = (url: string): string => (base ? new URL(url, base).href : url);
  const requires = await Promise.all(
    meta.require.map(async (url) => ({
      url,
      code: new TextDecoder().decode((await fetchBytes(resolve(url))).bytes),
    })),
  );
  const resources: NonNullable<Boost["resources"]> = {};
  for (const { name, url } of meta.resource) {
    const { bytes, mime } = await fetchBytes(resolve(url));
    resources[name] = { url, mime, data: toBase64(bytes) };
  }
  return { ...boost, requires, resources };
}

/** Which installed boost a script updates: same name and namespace. */
async function findExisting(boost: Boost): Promise<Boost | undefined> {
  const key = (b: Boost): string =>
    `${b.kind}|${b.meta?.namespace ?? ""}|${b.meta?.name ?? b.name}`;
  return (await allBoosts()).find((other) => other.kind !== "boost" && key(other) === key(boost));
}

export async function prepare(source: string, url?: string): Promise<Prepared> {
  const fresh = boostFromSource(source, newId());
  fresh.origin = { by: "install", url };
  const existing = await findExisting(fresh);
  let boost = await withDependencies(fresh, url);
  if (existing) {
    // An update keeps the person's switches, values, variable choices and history.
    boost = {
      ...boost,
      id: existing.id,
      enabled: existing.enabled,
      order: existing.order,
      created: existing.created,
      varValues: existing.varValues,
      tags: [...new Set([...existing.tags, ...boost.tags])],
    };
  }
  boost = await compileStyle(boost);
  return {
    boost,
    review: reviewBoost(boost),
    existing: existing
      ? { id: existing.id, name: existing.name, version: existing.meta?.version }
      : undefined,
    diff: existing ? unifiedDiff(existing.source ?? "", source) : undefined,
  };
}

export async function prepareFromUrl(url: string): Promise<Prepared> {
  return prepare(await fetchText(url), url);
}

export function install(prepared: Prepared): Promise<Boost> {
  const version = prepared.boost.meta?.version;
  return putBoost(
    prepared.boost,
    prepared.existing ? "update" : "install",
    version ? `Version ${version}` : undefined,
  );
}

// ---- Updates --------------------------------------------------------------------------

function versionOf(source: string): string | undefined {
  try {
    return isUserStyle(source) ? parseUserStyle(source).version : parseUserScript(source).version;
  } catch {
    return undefined;
  }
}

export interface UpdateResult {
  id: string;
  name: string;
  from?: string;
  to?: string;
  applied: boolean;
  error?: string;
}

/** Where to look for a newer version and where to download it from. */
function updateUrls(boost: Boost): { check: string; download: string } | undefined {
  const download = boost.meta?.downloadURL ?? boost.origin?.url;
  const check = boost.meta?.updateURL ?? download;
  return check && download && /^https?:/.test(check) ? { check, download } : undefined;
}

async function checkOne(boost: Boost, apply: boolean): Promise<UpdateResult | undefined> {
  const urls = updateUrls(boost);
  const installed = boost.meta?.version;
  if (!urls || !installed) return undefined;
  const { check, download } = urls;
  const header = await fetchText(check);
  const latest = versionOf(header);
  if (!latest || compareVersions(latest, installed) <= 0) return undefined;
  const result: UpdateResult = {
    id: boost.id,
    name: boost.name,
    from: installed,
    to: latest,
    applied: false,
  };
  if (!apply) return result;
  const source = check === download ? header : await fetchText(download);
  await install(await prepare(source, download));
  return { ...result, applied: true };
}

/** Checks every script with an update URL; applies updates when settings allow (or asked to). */
export async function checkUpdates(
  options: { ids?: string[]; apply?: boolean } = {},
): Promise<UpdateResult[]> {
  const settings = await getSettings();
  const apply = options.apply ?? settings.updates.apply === "auto";
  const results: UpdateResult[] = [];
  for (const boost of await allBoosts()) {
    if (boost.kind === "boost" || (options.ids && !options.ids.includes(boost.id))) continue;
    try {
      const result = await checkOne(boost, apply);
      if (result) results.push(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log({ level: "warn", boostId: boost.id, message: `Update check failed: ${message}` });
      results.push({ id: boost.id, name: boost.name, applied: false, error: message });
    }
  }
  await chrome.storage.local.set({ updates: { at: Date.now(), results } });
  return results;
}

const INSTALLABLE = /\.user\.(js|css)(?:[?#]|$)/i;
const skipOnce = new Set<string>();

/** Lets the next visit to this URL show the raw file. */
export function showSourceOnce(url: string): void {
  skipOnce.add(url);
}

/** Opens the install page instead of showing raw .user.js and .user.css files. */
export function interceptInstalls(): void {
  chrome.webNavigation.onBeforeNavigate.addListener(
    (details) => {
      if (details.frameId !== 0 || !INSTALLABLE.test(new URL(details.url).pathname + "#")) return;
      if (skipOnce.delete(details.url)) return;
      void chrome.tabs.update(details.tabId, {
        url: chrome.runtime.getURL(`install.html?url=${encodeURIComponent(details.url)}`),
      });
    },
    {
      url: [
        { schemes: ["http", "https"], pathSuffix: ".user.js" },
        { schemes: ["http", "https"], pathSuffix: ".user.css" },
      ],
    },
  );
}
