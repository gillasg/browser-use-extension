import { startBoostEngine, type BoostEngine, type BoostEngineOptions } from "site-boosts/embed";

// Boosts from Site Boosts' engine, built into this extension: saved page changes (styles, hidden
// elements, actions, network rules, scripts) that apply in every tab and survive restarts.
// Host extensions call installBoosts() in their service worker and include the content script
// from @browserkit/engine/boosts-build in their build.

let engine: BoostEngine | undefined;

export function installBoosts(
  contentScript = "boosts-content.js",
  options: Omit<BoostEngineOptions, "contentScript"> = {},
): void {
  engine ??= startBoostEngine({ contentScript, ...options });
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
  if (value.boosts === "save") {
    const boost = (value.boost ?? {}) as Request;
    return withScriptWarning(await engine.save(boost), boost);
  }
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

// Boost scripts run as user scripts, which Chrome only allows once the user switches on "Allow
// User Scripts" for this extension. Without it a saved script silently never runs, so say so.
async function withScriptWarning(saved: unknown, boost: Request): Promise<unknown> {
  if (typeof boost.js !== "string" || !boost.js.trim() || (await userScriptsAllowed()))
    return saved;
  const warning =
    "USER_SCRIPTS_OFF: the boost was saved, but its js will not run until the user turns on " +
    '"Allow User Scripts" for this extension (chrome://extensions > Details). Its css, zaps, ' +
    "actions and network rules apply already. Tell the user.";
  return saved && typeof saved === "object" ? { ...saved, warning } : { saved, warning };
}
async function userScriptsAllowed(): Promise<boolean> {
  try {
    await chrome.userScripts.getScripts();
    return true;
  } catch {
    return false;
  }
}
