import { fromZip, newId, parseBundle, toBundle, toZip, type Bundle } from "../shared/bundle.js";
import type { Boost, Settings } from "../shared/types.js";
import {
  allBoosts,
  getBoost,
  getSettings,
  getValues,
  putBoost,
  setSettings,
  setValues,
} from "./store.js";

// Backups (JSON or ZIP), restoring them, and syncing through a WebDAV folder.

/** Settings without secrets: keys and passwords never leave in a backup. */
function shareableSettings(settings: Settings): Partial<Settings> {
  const { model, siteApi, webdav, ...rest } = settings;
  return {
    ...rest,
    model: model ? { ...model, apiKey: undefined } : undefined,
    siteApi: siteApi ? { ...siteApi, token: "" } : undefined,
    webdav: webdav ? { url: webdav.url, user: webdav.user } : undefined,
  };
}

export async function exportBundle(ids?: string[]): Promise<Bundle> {
  const boosts = (await allBoosts()).filter((b) => !ids || ids.includes(b.id));
  const values: Record<string, Record<string, unknown>> = {};
  for (const boost of boosts) {
    const stored = await getValues(boost.id);
    if (Object.keys(stored).length) values[boost.id] = stored;
  }
  return toBundle(boosts, {
    values,
    settings: ids ? undefined : shareableSettings(await getSettings()),
  });
}

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

export async function exportZip(): Promise<string> {
  return toBase64(toZip(await exportBundle()));
}

export interface ImportResult {
  added: number;
  updated: number;
  skipped: number;
}

/** Restores a bundle: boosts with a known id are replaced when the incoming copy is newer. */
export async function importBundle(bundle: Bundle, keepIds = true): Promise<ImportResult> {
  const result: ImportResult = { added: 0, updated: 0, skipped: 0 };
  for (const incoming of bundle.boosts) {
    const existing = keepIds ? await getBoost(incoming.id) : undefined;
    if (existing && existing.updated >= incoming.updated) {
      result.skipped++;
      continue;
    }
    const boost: Boost = keepIds ? incoming : { ...incoming, id: newId() };
    await putBoost(boost, "import", existing ? "Restored from a backup" : "Imported");
    const values = bundle.values?.[incoming.id];
    if (values) await setValues(boost.id, values);
    if (existing) result.updated++;
    else result.added++;
  }
  return result;
}

export async function importText(text: string): Promise<ImportResult> {
  const bundle = parseBundle(text);
  // Shared boosts and loose scripts get new ids; full backups keep theirs.
  return importBundle(bundle, Boolean(bundle.settings));
}

export async function importZip(base64: string): Promise<ImportResult> {
  return importBundle(fromZip(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))));
}

// ---- WebDAV -----------------------------------------------------------------------------

function davRequest(
  settings: NonNullable<Settings["webdav"]>,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (settings.user)
    headers.set("authorization", "Basic " + btoa(`${settings.user}:${settings.password ?? ""}`));
  return fetch(settings.url.replace(/\/?$/, "/") + "site-boosts.json", {
    ...init,
    headers,
    cache: "no-store",
  });
}

/** Two-way sync: the newer copy of each boost wins; boosts on only one side are kept. */
export async function syncWebdav(): Promise<ImportResult & { uploaded: number }> {
  const settings = await getSettings();
  const dav = settings.webdav;
  if (!dav?.url) throw new Error("Set a WebDAV folder first");
  const remote = await davRequest(dav);
  let result: ImportResult = { added: 0, updated: 0, skipped: 0 };
  if (remote.ok) result = await importBundle(parseBundle(await remote.text()));
  else if (remote.status !== 404) throw new Error(`The WebDAV server answered ${remote.status}`);
  const local = await exportBundle();
  const upload = await davRequest(dav, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(local),
  });
  if (!upload.ok) throw new Error(`Uploading to WebDAV failed (${upload.status})`);
  await setSettings({ webdav: { ...dav, lastSync: Date.now() } });
  return { ...result, uploaded: local.boosts.length };
}
