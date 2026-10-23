import { normalizeBoost } from "../shared/bundle.js";
import { boostMatches } from "../shared/match.js";
import { errorText } from "../shared/messages.js";
import { author, discard, keep } from "./author.js";
import {
  getSettings,
  allBoosts,
  deleteBoost,
  getBoost,
  patchBoost,
  putBoost,
  allHealth,
} from "./store.js";

// Requests from a companion extension (the one set in settings, or a known one): it can list,
// write and switch boosts, and ask for boosts to be written on a tab.

const KNOWN = new Set(["dmlgohfphkbenjopdphcojgjeidlmajj", "npcdopokfkpfmepknhoecppgdgmkmihh"]);

type Handler = (data: Record<string, unknown>) => unknown;

export function listenToCompanions(changed: () => Promise<void>): void {
  const after = async <T>(value: T): Promise<T> => {
    await changed();
    return value;
  };
  const handlers: Record<string, Handler> = {
    ping: () => ({
      name: "Site Boosts",
      version: chrome.runtime.getManifest().version,
      features: ["boosts", "author"],
    }),
    "boosts.list": async ({ url }) => {
      const boosts = (await allBoosts()).filter(
        (b) => typeof url !== "string" || boostMatches(b, url),
      );
      const health = await allHealth();
      return boosts.map((b) => ({
        id: b.id,
        name: b.name,
        description: b.description,
        kind: b.kind,
        enabled: b.enabled,
        sites: b.sites,
        health: health[b.id]?.status ?? "unknown",
      }));
    },
    "boosts.get": ({ id }) => getBoost(String(id)),
    "boosts.save": async ({ boost }) => {
      const input = normalizeBoost(boost);
      const existing = await getBoost(input.id);
      return after(
        await putBoost({ ...input, origin: existing?.origin ?? { by: "companion" } }, "companion"),
      );
    },
    "boosts.toggle": async ({ id, enabled }) =>
      after(await patchBoost(String(id), { enabled: enabled === true })),
    "boosts.delete": async ({ id }) => after(await deleteBoost(String(id))),
    "boosts.author": ({ tabId, request, boostId }) =>
      author(Number(tabId), String(request), typeof boostId === "string" ? boostId : undefined),
    "boosts.keep": async ({ tabId }) => after(await keep(Number(tabId))),
    "boosts.discard": ({ tabId }) => discard(Number(tabId)),
  };
  chrome.runtime.onMessageExternal.addListener(
    (message: { type?: string; kind?: string; data?: Record<string, unknown> }, sender, reply) => {
      if (message?.type !== "site-boosts") return false;
      void (async () => {
        const settings = await getSettings();
        if (!sender.id || (sender.id !== settings.companionId && !KNOWN.has(sender.id)))
          return reply({ ok: false, error: "Not an allowed companion" });
        const handler = handlers[String(message.kind)];
        if (!handler) return reply({ ok: false, error: `Unknown request ${message.kind}` });
        try {
          reply({ ok: true, value: await handler(message.data ?? {}) });
        } catch (error) {
          reply({ ok: false, error: errorText(error) });
        }
      })();
      return true;
    },
  );
}
