import type { SiteApiSummary } from "../shared/ai.js";
import { getSettings, setSettings } from "./store.js";

// Optional integrations:
// - site-to-api: a local server (`site-to-api serve`) whose mapped site APIs boosts can call.
// - A companion extension: lends its signed-in model, and takes requests such as watching a price.

/** Extensions known to answer the companion protocol, checked when none is set. */
const KNOWN_COMPANIONS = ["dmlgohfphkbenjopdphcojgjeidlmajj", "npcdopokfkpfmepknhoecppgdgmkmihh"];

interface CompanionReply<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

export interface CompanionInfo {
  id: string;
  name: string;
  features: string[];
}

async function ask<T>(id: string, kind: string, data?: unknown, timeoutMs = 120_000): Promise<T> {
  const reply = (await Promise.race([
    chrome.runtime.sendMessage(id, { type: "site-boosts", kind, data }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("The companion extension did not answer")), timeoutMs),
    ),
  ])) as CompanionReply<T> | undefined;
  if (!reply) throw new Error("The companion extension did not answer");
  if (!reply.ok) throw new Error(reply.error ?? "The companion extension refused");
  return reply.value as T;
}

/** Finds an installed companion (the one in settings first). */
export async function findCompanion(): Promise<CompanionInfo | undefined> {
  const settings = await getSettings();
  const ids = [
    ...new Set(
      [settings.companionId, ...KNOWN_COMPANIONS].filter((id): id is string => Boolean(id)),
    ),
  ];
  for (const id of ids) {
    try {
      const info = await ask<{ name: string; features: string[] }>(id, "ping", undefined, 1500);
      if (settings.companionId !== id) await setSettings({ companionId: id });
      return { id, ...info };
    } catch {
      /* not installed, or not a companion */
    }
  }
  return undefined;
}

async function companionId(): Promise<string> {
  const settings = await getSettings();
  if (settings.companionId) return settings.companionId;
  const found = await findCompanion();
  if (!found) throw new Error("No companion extension is installed");
  return found.id;
}

export async function callCompanion(
  kind: string,
  data: unknown,
  from: Record<string, unknown>,
): Promise<unknown> {
  return ask(await companionId(), kind, { ...((data as object) ?? {}), from });
}

/** A model call through the companion's own sign-in. */
export async function companionComplete(
  system: string,
  messages: { role: string; content: string }[],
): Promise<string> {
  const value = await ask<{ text: string }>(await companionId(), "model.complete", {
    system,
    messages,
  });
  return value.text;
}

// ---- site-to-api ------------------------------------------------------------------------

async function siteApi(): Promise<{ url: string; token: string }> {
  const settings = await getSettings();
  if (!settings.siteApi?.url)
    throw new Error("Connect a site-to-api server in the settings to use site APIs");
  return { ...settings.siteApi, url: settings.siteApi.url.replace(/\/+$/, "") };
}

export async function callSiteApi(
  site: string,
  operation: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const { url, token } = await siteApi();
  const response = await fetch(
    `${url}/sites/${encodeURIComponent(site)}/ops/${encodeURIComponent(operation)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-site-to-api-token": token },
      body: JSON.stringify(params),
    },
  );
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(body.error ?? `site-to-api answered ${response.status}`);
  return body;
}

interface OpenApi {
  paths?: Record<string, Record<string, { operationId?: string; summary?: string }>>;
}

/** The mapped sites and their operations, for the model. Empty when no server is connected. */
export async function listSiteApis(): Promise<SiteApiSummary[]> {
  let server: { url: string; token: string };
  try {
    server = await siteApi();
  } catch {
    return [];
  }
  try {
    const headers = { "x-site-to-api-token": server.token };
    const sites = (await (await fetch(`${server.url}/sites`, { headers })).json()) as {
      site: string;
    }[];
    return await Promise.all(
      sites.slice(0, 20).map(async ({ site }) => {
        const spec = (await (
          await fetch(`${server.url}/sites/${encodeURIComponent(site)}/openapi.json`, { headers })
        ).json()) as OpenApi;
        const operations = Object.entries(spec.paths ?? {}).flatMap(([path, methods]) =>
          Object.entries(methods)
            .filter(([, op]) => op?.operationId)
            .map(([method, op]) => ({
              id: op.operationId as string,
              summary: op.summary,
              method: method.toUpperCase(),
              path,
            })),
        );
        return { site, operations };
      }),
    );
  } catch {
    return [];
  }
}
