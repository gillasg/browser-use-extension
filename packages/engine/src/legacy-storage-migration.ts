// One-time move of extension storage written before the rename to Aeon. Old keys
// that began with the previous product name are copied to the matching new key
// when the new key is absent, then removed. Safe to run repeatedly and concurrently.
const LEGACY_PREFIX = "pippin";
const CURRENT_PREFIX = "aeon";

function currentKey(legacyKey: string): string {
  return CURRENT_PREFIX + legacyKey.slice(LEGACY_PREFIX.length);
}

async function migrateArea(area: chrome.storage.StorageArea): Promise<void> {
  const values = await area.get(null);
  const legacyKeys = Object.keys(values).filter((key) => key.startsWith(LEGACY_PREFIX));
  if (legacyKeys.length === 0) return;
  const copies: Record<string, unknown> = {};
  for (const key of legacyKeys) {
    const next = currentKey(key);
    if (!(next in values)) copies[next] = values[key];
  }
  if (Object.keys(copies).length > 0) await area.set(copies);
  await area.remove(legacyKeys);
}

let chromeMigration: Promise<void> | undefined;

export function migrateLegacyChromeStorage(): Promise<void> {
  chromeMigration ??= Promise.all(
    [chrome.storage.sync, chrome.storage.local, chrome.storage.session].map((area) =>
      migrateArea(area).catch(() => undefined),
    ),
  ).then(() => undefined);
  return chromeMigration;
}

export function migrateLegacyLocalStorage(): void {
  try {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith(LEGACY_PREFIX)) continue;
      const next = currentKey(key);
      const value = localStorage.getItem(key);
      if (value !== null && localStorage.getItem(next) === null) localStorage.setItem(next, value);
      localStorage.removeItem(key);
    }
  } catch {
    // Storage can be unavailable; the new keys then simply start empty.
  }
}
