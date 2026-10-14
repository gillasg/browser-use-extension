import type { Boost, HealthReport } from "../shared/types.js";
import { errorText } from "../shared/messages.js";
import { callCompanion, callSiteApi } from "./integrations.js";
import { recordHealth } from "./health.js";
import { copyToClipboard } from "./offscreen.js";
import { syncSoon } from "./scripts.js";
import { getBoost, getValues, log, setValues } from "./store.js";
import { mayConnect, runXhr, type XhrArgs } from "./xhr.js";

// The service-worker side of the userscript API: one port per running script.

interface Call {
  t: "call" | "cancel";
  id: number;
  op: string;
  args?: Record<string, unknown>;
  stream?: boolean;
}

interface Ctx {
  boost: Boost;
  port: chrome.runtime.Port;
  tabId?: number;
  frameId?: number;
  url?: string;
}

/** Operations that need a grant, by the API names that allow them. */
const NEEDS: Record<string, string[]> = {
  xhr: ["xmlhttpRequest", "xmlHttpRequest"],
  download: ["download"],
  notify: ["notification"],
  clipboard: ["setClipboard"],
  "tab.open": ["openInTab"],
  "tab.close": ["openInTab"],
  "cookie.list": ["cookie"],
  "cookie.set": ["cookie"],
  "cookie.delete": ["cookie"],
  "tab.get": ["getTab"],
  "tab.save": ["saveTab"],
  "tabs.list": ["getTabs"],
  "audio.mute": ["audio"],
  "audio.state": ["audio"],
};

function granted(boost: Boost, op: string): boolean {
  const names = NEEDS[op];
  if (!names || boost.kind === "boost") return true;
  const grants = boost.meta?.grant ?? [];
  return names.some((name) => grants.includes(`GM_${name}`) || grants.includes(`GM.${name}`));
}

const ports = new Map<string, Set<chrome.runtime.Port>>();
const streams = new Map<string, AbortController>();
const tabStore = new Map<string, Map<number, unknown>>();
const opened = new Map<number, chrome.runtime.Port>();

export interface MenuCommand {
  boostId: string;
  id: string;
  caption: string;
  title?: string;
  port: chrome.runtime.Port;
}
const menus = new Map<number, Map<string, MenuCommand>>();

export function menuCommands(tabId: number): Omit<MenuCommand, "port">[] {
  return [...(menus.get(tabId)?.values() ?? [])].map(({ boostId, id, caption, title }) => ({
    boostId,
    id,
    caption,
    title,
  }));
}

export function runMenuCommand(tabId: number, boostId: string, id: string): void {
  menus
    .get(tabId)
    ?.get(`${boostId}:${id}`)
    ?.port.postMessage({ t: "push", event: "menu", data: { id } });
}

/** Tells every running copy of a script (but `except`) about a value change. */
function broadcastValue(boostId: string, data: unknown, except?: chrome.runtime.Port): void {
  for (const port of ports.get(boostId) ?? [])
    if (port !== except) port.postMessage({ t: "push", event: "value", data });
}

async function changeValues(
  ctx: Ctx,
  change: (values: Record<string, unknown>) => void,
  push: unknown,
): Promise<void> {
  const values = await getValues(ctx.boost.id);
  change(values);
  await setValues(ctx.boost.id, values);
  broadcastValue(ctx.boost.id, push, ctx.port);
  syncSoon();
}

function notify(args: Record<string, unknown>): Promise<boolean> {
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    chrome.notifications.create(id, {
      type: "basic",
      title: String(args.title ?? "Site Boosts"),
      message: String(args.text ?? ""),
      iconUrl:
        typeof args.image === "string" && args.image
          ? args.image
          : chrome.runtime.getURL("icon-128.png"),
      silent: args.silent === true,
    });
    const done = (clicked: boolean): void => {
      chrome.notifications.onClicked.removeListener(onClick);
      chrome.notifications.onClosed.removeListener(onClose);
      resolve(clicked);
    };
    const onClick = (clickedId: string): void => {
      if (clickedId !== id) return;
      void chrome.notifications.clear(id);
      done(true);
    };
    const onClose = (closedId: string): void => {
      if (closedId === id) done(false);
    };
    chrome.notifications.onClicked.addListener(onClick);
    chrome.notifications.onClosed.addListener(onClose);
    const timeout = Number(args.timeout);
    if (timeout > 0) setTimeout(() => void chrome.notifications.clear(id), timeout);
  });
}

function cookieTarget(ctx: Ctx, args: Record<string, unknown>): { url: string } {
  const url = String(args.url ?? ctx.url ?? "");
  if (
    !mayConnect(
      url,
      ctx.url,
      ctx.boost.kind === "boost" ? undefined : (ctx.boost.meta?.connect ?? []),
    )
  )
    throw new Error(`Not allowed to use cookies of ${url}`);
  return { url };
}

type Handler = (ctx: Ctx, args: Record<string, unknown>) => Promise<unknown> | unknown;

const handlers: Record<string, Handler> = {
  started: () => undefined,
  "values.set": (ctx, { key, value }) =>
    changeValues(ctx, (v) => (v[String(key)] = value), { key, value }),
  "values.delete": (ctx, { key }) =>
    changeValues(ctx, (v) => delete v[String(key)], { key, deleted: true }),
  "css.insert": (ctx, { css }) =>
    ctx.tabId === undefined
      ? undefined
      : chrome.scripting.insertCSS({
          target: { tabId: ctx.tabId, frameIds: [ctx.frameId ?? 0] },
          css: String(css),
          origin: "USER",
        }),
  log: (ctx, { text, level, stack }) =>
    log({
      level: level === "error" ? "error" : "info",
      boostId: ctx.boost.id,
      url: ctx.url,
      message: String(text) + (typeof stack === "string" ? `\n${stack}` : ""),
    }),
  health: (ctx, { selectors, errors }) =>
    recordHealth(
      ctx.boost.id,
      {
        url: ctx.url ?? "",
        source: "script",
        at: Date.now(),
        selectors: (selectors as HealthReport["selectors"]) ?? [],
        actionsRun: 0,
        errors: (errors as string[]) ?? [],
      },
      ctx.tabId,
    ),
  notify: (_ctx, args) => notify(args),
  clipboard: (_ctx, { data, type }) =>
    copyToClipboard(String(data), typeof type === "string" ? type : undefined),
  download: (_ctx, args) =>
    chrome.downloads.download({
      url: String(args.url),
      filename: typeof args.name === "string" ? args.name.replace(/[<>:"|?*]/g, "_") : undefined,
      saveAs: args.saveAs === true,
      conflictAction: args.conflictAction === "overwrite" ? "overwrite" : "uniquify",
      headers: Object.entries((args.headers as Record<string, string> | undefined) ?? {}).map(
        ([name, value]) => ({ name, value }),
      ),
    }),
  "tab.open": async (ctx, { url, active, insert }) => {
    const sender =
      ctx.tabId === undefined ? undefined : await chrome.tabs.get(ctx.tabId).catch(() => undefined);
    const tab = await chrome.tabs.create({
      url: String(url),
      active: active !== false,
      ...(sender && insert !== false ? { index: sender.index + 1, openerTabId: sender.id } : {}),
    });
    if (tab.id !== undefined) opened.set(tab.id, ctx.port);
    return tab.id;
  },
  "tab.close": (_ctx, { tabId }) =>
    opened.has(Number(tabId)) ? chrome.tabs.remove(Number(tabId)) : undefined,
  "tab.get": (ctx) => tabStore.get(ctx.boost.id)?.get(ctx.tabId ?? -1) ?? {},
  "tab.save": (ctx, { tab }) => {
    const store = tabStore.get(ctx.boost.id) ?? new Map<number, unknown>();
    store.set(ctx.tabId ?? -1, tab);
    tabStore.set(ctx.boost.id, store);
  },
  "tabs.list": (ctx) => Object.fromEntries(tabStore.get(ctx.boost.id) ?? []),
  "cookie.list": (ctx, args) =>
    chrome.cookies.getAll({
      ...cookieTarget(ctx, args),
      ...(typeof args.name === "string" ? { name: args.name } : {}),
    }),
  "cookie.set": (ctx, args) =>
    chrome.cookies.set({
      ...(args as object),
      ...cookieTarget(ctx, args),
    } as chrome.cookies.SetDetails),
  "cookie.delete": (ctx, args) =>
    chrome.cookies.remove({ ...cookieTarget(ctx, args), name: String(args.name) }),
  "audio.mute": (ctx, { isMuted }) =>
    ctx.tabId === undefined
      ? undefined
      : chrome.tabs.update(ctx.tabId, { muted: Boolean(isMuted) }),
  "audio.state": async (ctx) => {
    if (ctx.tabId === undefined) return undefined;
    const tab = await chrome.tabs.get(ctx.tabId);
    return {
      isMuted: tab.mutedInfo?.muted ?? false,
      muteReason: tab.mutedInfo?.reason,
      isAudible: tab.audible ?? false,
    };
  },
  "menu.register": (ctx, { id, caption, title }) => {
    if (ctx.tabId === undefined) return;
    const list = menus.get(ctx.tabId) ?? new Map<string, MenuCommand>();
    list.set(`${ctx.boost.id}:${String(id)}`, {
      boostId: ctx.boost.id,
      id: String(id),
      caption: String(caption),
      title: typeof title === "string" ? title : undefined,
      port: ctx.port,
    });
    menus.set(ctx.tabId, list);
  },
  "menu.unregister": (ctx, { id }) =>
    menus.get(ctx.tabId ?? -1)?.delete(`${ctx.boost.id}:${String(id)}`),
  api: (_ctx, { site, operation, params }) =>
    callSiteApi(String(site), String(operation), (params as Record<string, unknown>) ?? {}),
  companion: (ctx, { kind, data }) =>
    callCompanion(String(kind), data, { boost: ctx.boost.name, url: ctx.url }),
};

function startStream(ctx: Ctx, call: Call): void {
  const key = `${ctx.boost.id}:${call.id}:${ctx.tabId}:${ctx.frameId}`;
  const controller = new AbortController();
  streams.set(key, controller);
  const emit = (event: string, data?: unknown): void => {
    try {
      ctx.port.postMessage({ t: "event", id: call.id, event, data });
    } catch {
      controller.abort();
    }
  };
  const args = (call.args ?? {}) as unknown as XhrArgs;
  const connect = ctx.boost.kind === "boost" ? undefined : (ctx.boost.meta?.connect ?? []);
  if (!mayConnect(args.url, ctx.url, connect)) {
    emit("error", {
      status: 0,
      error: `This script may not connect to ${new URL(args.url).hostname}: add it to @connect`,
    });
    emit("done");
    return;
  }
  void runXhr(args, emit, controller.signal).finally(() => streams.delete(key));
}

async function handle(ctx: Ctx, call: Call): Promise<void> {
  if (call.t === "cancel") {
    streams.get(`${ctx.boost.id}:${call.id}:${ctx.tabId}:${ctx.frameId}`)?.abort();
    return;
  }
  if (!granted(ctx.boost, call.op)) {
    ctx.port.postMessage({ t: "reply", id: call.id, error: `${call.op} needs a @grant` });
    return;
  }
  if (call.stream && call.op === "xhr") return startStream(ctx, call);
  const handler = handlers[call.op];
  try {
    if (!handler) throw new Error(`Unknown operation ${call.op}`);
    const value = await handler(ctx, call.args ?? {});
    ctx.port.postMessage({ t: "reply", id: call.id, value: value === undefined ? null : value });
  } catch (error) {
    try {
      ctx.port.postMessage({ t: "reply", id: call.id, error: errorText(error) });
    } catch {
      /* the page went away */
    }
  }
}

export function listenToScripts(): void {
  chrome.runtime.onUserScriptConnect.addListener((port) => {
    const boostId = port.name.startsWith("sb:") ? port.name.slice(3) : "";
    const set = ports.get(boostId) ?? new Set();
    set.add(port);
    ports.set(boostId, set);
    const ctxPromise = getBoost(boostId).then((boost) =>
      boost
        ? {
            boost,
            port,
            tabId: port.sender?.tab?.id,
            frameId: port.sender?.frameId,
            url: port.sender?.url,
          }
        : undefined,
    );
    port.onMessage.addListener((call: Call) => {
      void ctxPromise.then((ctx) => (ctx ? handle(ctx, call) : undefined));
    });
    port.onDisconnect.addListener(() => {
      set.delete(port);
      for (const list of menus.values())
        for (const [key, command] of list) if (command.port === port) list.delete(key);
    });
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    menus.delete(tabId);
    for (const store of tabStore.values()) store.delete(tabId);
    const port = opened.get(tabId);
    opened.delete(tabId);
    try {
      port?.postMessage({ t: "push", event: "tab.closed", data: { tabId } });
    } catch {
      /* gone */
    }
  });
}

/** Pushes a value change made outside the scripts (the storage editor). */
export function valuesChangedOutside(boostId: string, values: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(values)) broadcastValue(boostId, { key, value });
}
