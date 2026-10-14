import { chromePatterns, ruleRegexSource } from "../shared/match.js";
import type { Boost, SiteRule } from "../shared/types.js";
import { GLOBAL_NAMES } from "../runtime/index.js";
import { allBoosts, getSettings, getSites, getValues, log } from "./store.js";

// Boosts with JavaScript (and userscripts) run through chrome.userScripts: each one is registered
// with its runtime, @require code, a snapshot of its stored values and an exact URL check.

declare const __GM_RUNTIME__: string;

const PREFIX = "sb-";
const HEADER = /==UserScript==[\s\S]*?==\/UserScript==/;
const WORLD_CSP = "script-src 'self' 'unsafe-inline' 'unsafe-eval'; object-src 'none'";

export async function userScriptsAvailable(): Promise<boolean> {
  try {
    await chrome.userScripts.getScripts();
    return true;
  } catch {
    return false;
  }
}

const runAt = (boost: Boost): chrome.userScripts.RegisteredUserScript["runAt"] => {
  const value = boost.runAt ?? "document-idle";
  if (value === "document-start" || value === "document-body") return "document_start";
  if (value === "document-end") return "document_end";
  return "document_idle";
};

function scriptInfo(boost: Boost): Record<string, unknown> {
  const meta = { match: [], include: [], exclude: [], grant: [], resource: [], ...boost.meta };
  const injectInto = boost.jsWorld === "isolated" ? "content" : "page";
  return {
    script: {
      name: boost.name,
      namespace: meta.namespace,
      version: meta.version,
      description: boost.description,
      author: meta.author,
      homepage: meta.homepage,
      icon: meta.icon,
      matches: meta.match,
      includes: meta.include,
      excludes: meta.exclude,
      grant: meta.grant,
      resources: meta.resource.map((r) => ({ name: r.name, url: r.url })),
      "run-at": boost.runAt,
      "inject-into": injectInto,
      tags: boost.tags,
      uuid: boost.id,
    },
    scriptMetaStr: HEADER.exec(boost.source ?? "")?.[0] ?? "",
    scriptHandler: "Site Boosts",
    version: chrome.runtime.getManifest().version,
    injectInto,
    uuid: boost.id,
  };
}

/** Exact URL check: the registered match patterns are only a coarse first filter. */
function urlCheck(includes: SiteRule[], excludes: SiteRule[]): string {
  const list = (rules: SiteRule[]): string =>
    `[${rules.map((rule) => `new RegExp(${JSON.stringify(ruleRegexSource(rule))}, "i")`).join(",")}]`;
  return `const __href = location.href; if (!${list(includes)}.some((r) => r.test(__href)) || ${list(excludes)}.some((r) => r.test(__href))) return;`;
}

const WAIT_FOR_BODY = `if (!document.body) await new Promise((done) => new MutationObserver((_, observer) => { if (document.body) { observer.disconnect(); done(); } }).observe(document.documentElement, { childList: true }));`;

export interface Built {
  main: chrome.userScripts.RegisteredUserScript;
  bridge?: chrome.userScripts.RegisteredUserScript;
}

/** The script's code: the URL check, the runtime, its @require code and its own code. */
function scriptCode(
  boost: Boost,
  values: Record<string, unknown>,
  check: string,
  nonce: string,
): string {
  const config = {
    id: boost.id,
    nonce,
    world: boost.jsWorld === "isolated" ? "isolated" : "page",
    grantAll: boost.kind === "boost",
    grants: boost.meta?.grant ?? [],
    values,
    resources: boost.resources ?? {},
    info: scriptInfo(boost),
  };
  const requires = (boost.requires ?? []).map((r) => `${r.code}\n;`).join("\n");
  const body = boost.runAt === "document-body" ? `${WAIT_FOR_BODY}\n` : "";
  return [
    `(() => { ${check}`,
    __GM_RUNTIME__,
    `const __sb = __sbRuntime.start(${JSON.stringify(config)});`,
    `const { ${GLOBAL_NAMES.join(", ")} } = __sb;`,
    `(async function () { ${body}`,
    requires,
    `try {\n${boost.js ?? ""}\n} catch (error) { __sb.__report(error); }`,
    `}).call(window).catch((error) => __sb.__report(error));`,
    `})();`,
  ].join("\n");
}

/** The registrations for one boost. `blocked` are rules where it must not run (site switches). */
export function buildRegistration(
  boost: Boost,
  values: Record<string, unknown>,
  blocked: SiteRule[],
  nonce: string,
): Built {
  const page = boost.jsWorld !== "isolated";
  const check = urlCheck(boost.sites, [...(boost.excludes ?? []), ...blocked]);
  const matches = chromePatterns(boost.sites);
  const common = {
    matches: matches.includes("<all_urls>") ? ["<all_urls>"] : matches,
    excludeMatches: (boost.excludes ?? [])
      .filter((r) => r.type === "match")
      .map((r) => r.value as string),
    runAt: runAt(boost),
    allFrames: boost.allFrames ?? false,
  };
  const worldId = PREFIX + boost.id;
  const main: chrome.userScripts.RegisteredUserScript = {
    id: PREFIX + boost.id,
    ...common,
    js: [{ code: scriptCode(boost, values, check, nonce) }],
    ...(page ? { world: "MAIN" } : { world: "USER_SCRIPT", worldId }),
  };
  if (!page) return { main };
  const bridge: chrome.userScripts.RegisteredUserScript = {
    id: `${PREFIX}${boost.id}-bridge`,
    ...common,
    // The bridge must be listening before the script starts.
    runAt: "document_start",
    js: [
      {
        code: `(() => { ${check}\n${__GM_RUNTIME__}\n__sbRuntime.bridge(${JSON.stringify(nonce)}, ${JSON.stringify(boost.id)}); })();`,
      },
    ],
    world: "USER_SCRIPT",
    worldId,
  };
  return { main, bridge };
}

/** Hosts where a boost must not run: the blocklist, sites switched off, and per-site switches. */
async function blockedRules(): Promise<(boost: Boost) => SiteRule[]> {
  const settings = await getSettings();
  const sites = await getSites();
  const global: SiteRule[] = settings.blocklist.map((value) =>
    value.includes("/") || value.includes("*")
      ? { type: "glob", value }
      : { type: "domain", value },
  );
  for (const [host, state] of Object.entries(sites))
    if (state.off) global.push({ type: "domain", value: host });
  return (boost) => [
    ...global,
    ...Object.entries(sites)
      .filter(([, state]) => state.boostsOff?.includes(boost.id))
      .map(([host]): SiteRule => ({ type: "domain", value: host })),
  ];
}

let secret: Promise<string> | undefined;
/** The name of the page/bridge channel: stable for this install, unknown to pages. */
async function nonceFor(id: string): Promise<string> {
  secret ??= chrome.storage.local.get("secret").then(async (stored) => {
    if (typeof stored.secret === "string") return stored.secret;
    const created = crypto.randomUUID().replace(/-/g, "");
    await chrome.storage.local.set({ secret: created });
    return created;
  });
  return (await secret) + id.replace(/\W/g, "");
}

let syncing: Promise<void> = Promise.resolve();

/** Brings the registered scripts in line with the stored boosts. */
export function syncScripts(): Promise<void> {
  syncing = syncing.catch(() => undefined).then(doSync);
  return syncing;
}

async function desiredScripts(): Promise<chrome.userScripts.RegisteredUserScript[]> {
  const settings = await getSettings();
  if (settings.paused) return [];
  const blocked = await blockedRules();
  const out: chrome.userScripts.RegisteredUserScript[] = [];
  for (const boost of await allBoosts()) {
    if (!boost.enabled || !boost.js || boost.runAt === "context-menu") continue;
    const built = buildRegistration(
      boost,
      await getValues(boost.id),
      blocked(boost),
      await nonceFor(boost.id),
    );
    if (built.bridge) out.push(built.bridge);
    out.push(built.main);
  }
  return out;
}

async function doSync(): Promise<void> {
  if (!(await userScriptsAvailable())) return;
  const desired = await desiredScripts();
  const existing = (await chrome.userScripts.getScripts()).filter((s) => s.id.startsWith(PREFIX));
  const wanted = new Map(desired.map((s) => [s.id, s]));
  const stale = existing.filter((s) => !wanted.has(s.id)).map((s) => s.id);
  if (stale.length) await chrome.userScripts.unregister({ ids: stale });
  const current = new Map(existing.map((s) => [s.id, s]));
  const added = desired.filter((s) => !current.has(s.id));
  const changed = desired.filter(
    (s) =>
      current.has(s.id) &&
      JSON.stringify(current.get(s.id)) !== JSON.stringify({ ...current.get(s.id), ...s }),
  );
  for (const script of [...added, ...changed])
    if (script.worldId)
      await chrome.userScripts.configureWorld({
        worldId: script.worldId,
        messaging: true,
        csp: WORLD_CSP,
      });
  try {
    if (added.length) await chrome.userScripts.register(added);
    if (changed.length) await chrome.userScripts.update(changed);
  } catch (error) {
    log({
      level: "error",
      message: `Could not register scripts: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

type Sources = [chrome.userScripts.ScriptSource, ...chrome.userScripts.ScriptSource[]];

/** Runs a script once in a tab now (context-menu scripts, previews). */
export async function runOnce(boost: Boost, tabId: number, frameId = 0): Promise<void> {
  const built = buildRegistration(
    { ...boost, runAt: "document-idle" },
    await getValues(boost.id),
    [],
    await nonceFor(boost.id),
  );
  const target = { tabId, frameIds: [frameId] };
  if (built.bridge) {
    await chrome.userScripts.configureWorld({
      worldId: PREFIX + boost.id,
      messaging: true,
      csp: WORLD_CSP,
    });
    await chrome.userScripts.execute({
      target,
      js: built.bridge.js as Sources,
      world: "USER_SCRIPT",
      worldId: PREFIX + boost.id,
    });
  } else
    await chrome.userScripts.configureWorld({
      worldId: PREFIX + boost.id,
      messaging: true,
      csp: WORLD_CSP,
    });
  await chrome.userScripts.execute({
    target,
    js: built.main.js as Sources,
    world: built.main.world,
    ...(built.main.worldId ? { worldId: built.main.worldId } : {}),
  });
}

/** Debounced re-registration, for stored-value changes. */
let pending: ReturnType<typeof setTimeout> | undefined;
export function syncSoon(): void {
  if (pending) clearTimeout(pending);
  pending = setTimeout(() => {
    pending = undefined;
    void syncScripts();
  }, 800);
}
