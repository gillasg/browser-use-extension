import { startBoostEngine, type BoostEngine } from "site-boosts/embed";

// Boosts from Site Boosts' engine, built into this extension: saved page changes (styles, hidden
// elements, actions, network rules, scripts) that apply in every tab and survive restarts.
// Host extensions call installBoosts() in their service worker and include the content script
// from @browser-use-extension/engine/boosts-build in their build.

let engine: BoostEngine | undefined;

export function installBoosts(contentScript = "boosts-content.js"): void {
  engine ??= startBoostEngine({ contentScript });
}

type Request = Record<string, unknown>;

export function isBoostsRequest(value: Request | null): boolean {
  return typeof value?.boosts === "string";
}

export async function boostsCall(value: Request): Promise<unknown> {
  if (!engine) throw new Error("UNSUPPORTED: boosts are not built into this extension");
  const id = String(value.id ?? "");
  if (value.boosts === "list")
    return engine.list(typeof value.url === "string" ? value.url : undefined);
  if (value.boosts === "get") return (await engine.get(id)) ?? null;
  if (value.boosts === "save") return engine.save((value.boost ?? {}) as Request);
  if (value.boosts === "remove") {
    await engine.remove(id);
    return { removed: id };
  }
  if (value.boosts === "enable") {
    await engine.setEnabled(id, value.enabled !== false);
    return { id, enabled: value.enabled !== false };
  }
  throw new Error("UNSUPPORTED: browser.boosts." + String(value.boosts));
}
