import type { Tracker } from "./tracker.js";
import type { Transport } from "./transport.js";
import { fromBase64, xmlHttpRequest, type XhrDetails } from "./xhr.js";

// The userscript API: GM_* functions and the promise-based GM.* object.

export interface ScriptConfig {
  id: string;
  nonce: string;
  world: "page" | "isolated";
  /** Boosts get every API; userscripts get what they @grant. */
  grantAll: boolean;
  grants: string[];
  values: Record<string, unknown>;
  resources: Record<string, { url: string; mime: string; data: string }>;
  info: Record<string, unknown>;
}

type Listener = (key: string, oldValue: unknown, newValue: unknown, remote: boolean) => void;
type Callback<T> = ((value: T) => void) | undefined;
type Api = Record<string, unknown>;

const clone = <T>(value: T): T =>
  value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);

export interface GmContext {
  config: ScriptConfig;
  transport: Transport;
  tracker: Tracker;
  report(error: unknown): void;
}

function valuesApi({ config, transport }: GmContext): Api {
  const values: Record<string, unknown> = { ...config.values };
  const listeners = new Map<number, { key: string; fn: Listener }>();
  let nextListener = 1;
  const changed = (key: string, oldValue: unknown, newValue: unknown, remote: boolean): void => {
    for (const { key: watched, fn } of listeners.values())
      if (watched === key) fn(key, oldValue, newValue, remote);
  };
  transport.onPush((event, data) => {
    if (event !== "value") return;
    const { key, value, deleted } = data as { key: string; value: unknown; deleted?: boolean };
    const before = values[key];
    if (deleted) delete values[key];
    else values[key] = value;
    changed(key, before, deleted ? undefined : value, true);
  });
  const set = (key: string, value: unknown): void => {
    const before = values[key];
    values[key] = clone(value);
    void transport.call("values.set", { key, value: values[key] });
    changed(key, before, value, false);
  };
  const remove = (key: string): void => {
    const before = values[key];
    delete values[key];
    void transport.call("values.delete", { key });
    changed(key, before, undefined, false);
  };
  const get = (key: string, fallback?: unknown): unknown =>
    key in values ? clone(values[key]) : fallback;
  const getMany = (keys: string[] | Record<string, unknown>): Record<string, unknown> =>
    Array.isArray(keys)
      ? Object.fromEntries(keys.filter((k) => k in values).map((k) => [k, get(k)]))
      : Object.fromEntries(Object.entries(keys).map(([k, fallback]) => [k, get(k, fallback)]));
  return {
    getValue: get,
    setValue: set,
    deleteValue: remove,
    listValues: () => Object.keys(values),
    getValues: getMany,
    setValues: (entries: Record<string, unknown>) =>
      Object.entries(entries).forEach(([k, v]) => set(k, v)),
    deleteValues: (keys: string[]) => keys.forEach(remove),
    addValueChangeListener: (key: string, fn: Listener) => {
      const id = nextListener++;
      listeners.set(id, { key, fn });
      return id;
    },
    removeValueChangeListener: (id: number) => listeners.delete(id),
  };
}

function addStyle({ transport }: GmContext, css: string): HTMLStyleElement {
  const style = document.createElement("style");
  style.textContent = css;
  (document.head ?? document.documentElement).appendChild(style);
  // A strict Content-Security-Policy blocks inline styles: let the extension insert it instead.
  if (!style.sheet) void transport.call("css.insert", { css });
  return style;
}

function addElement(
  parentOrTag: Node | string,
  tagOrAttrs?: string | Record<string, unknown>,
  attrs?: Record<string, unknown>,
): Element {
  const parent =
    typeof parentOrTag === "string" ? (document.head ?? document.documentElement) : parentOrTag;
  const tag = typeof parentOrTag === "string" ? parentOrTag : String(tagOrAttrs);
  const attributes = (typeof parentOrTag === "string" ? tagOrAttrs : attrs) as
    Record<string, unknown> | undefined;
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes ?? {})) {
    if (name === "textContent" || name === "innerHTML")
      (element as unknown as Record<string, unknown>)[name] = value;
    else element.setAttribute(name, String(value));
  }
  parent.appendChild(element);
  return element;
}

function resourcesApi({ config }: GmContext): Api {
  const blobs = new Map<string, string>();
  return {
    getResourceText: (name: string) => {
      const resource = config.resources[name];
      return resource ? new TextDecoder().decode(fromBase64(resource.data)) : undefined;
    },
    getResourceURL: (name: string, asBlob = true) => {
      const resource = config.resources[name];
      if (!resource) return undefined;
      if (!asBlob) return `data:${resource.mime};base64,${resource.data}`;
      if (!blobs.has(name))
        blobs.set(
          name,
          URL.createObjectURL(new Blob([fromBase64(resource.data)], { type: resource.mime })),
        );
      return blobs.get(name);
    },
  };
}

function menuApi({ transport, report }: GmContext): Api {
  const commands = new Map<string, (event?: unknown) => void>();
  let next = 1;
  transport.onPush((event, data) => {
    if (event !== "menu") return;
    try {
      commands.get(String((data as { id: string }).id))?.(data);
    } catch (error) {
      report(error);
    }
  });
  return {
    registerMenuCommand: (
      caption: string,
      fn: (event?: unknown) => void,
      options?:
        string | { id?: string | number; accessKey?: string; title?: string; autoClose?: boolean },
    ) => {
      const id = String((typeof options === "object" && options.id) || next++);
      commands.set(id, fn);
      void transport.call("menu.register", {
        id,
        caption,
        title: typeof options === "object" ? options.title : undefined,
      });
      return id;
    },
    unregisterMenuCommand: (id: string | number) => {
      commands.delete(String(id));
      void transport.call("menu.unregister", { id: String(id) });
    },
  };
}

function tabsApi({ transport }: GmContext): Api {
  return {
    getTab: (callback: Callback<unknown>) =>
      transport.call("tab.get").then((tab) => (callback?.(tab), tab)),
    saveTab: (tab: unknown) => transport.call("tab.save", { tab: clone(tab) }),
    getTabs: (callback: Callback<unknown>) =>
      transport.call("tabs.list").then((tabs) => (callback?.(tabs), tabs)),
    openInTab: (
      url: string,
      options?:
        boolean | { active?: boolean; insert?: boolean; setParent?: boolean; incognito?: boolean },
    ) => {
      const active = typeof options === "boolean" ? !options : (options?.active ?? true);
      const handle: { closed: boolean; onclose?: () => void; close(): void; tabId?: number } = {
        closed: false,
        close() {
          void ready.then((tabId) => transport.call("tab.close", { tabId }));
        },
      };
      const ready = transport.call("tab.open", {
        url: new URL(url, location.href).href,
        active,
        insert: typeof options === "object" ? options.insert : true,
      }) as Promise<number>;
      void ready.then((tabId) => (handle.tabId = tabId));
      transport.onPush((event, data) => {
        if (event === "tab.closed" && (data as { tabId: number }).tabId === handle.tabId) {
          handle.closed = true;
          handle.onclose?.();
        }
      });
      return handle;
    },
  };
}

function cookieApi({ transport }: GmContext): Api {
  const wrap =
    (op: string) =>
    (
      details: Record<string, unknown>,
      callback?: (result: unknown, error?: string) => void,
    ): Promise<unknown> =>
      transport.call(op, { url: location.href, ...details }).then(
        (result) => (callback?.(result), result),
        (error: Error) => {
          callback?.(undefined, error.message);
          throw error;
        },
      );
  return { list: wrap("cookie.list"), set: wrap("cookie.set"), delete: wrap("cookie.delete") };
}

function miscApi(context: GmContext): Api {
  const { transport, report } = context;
  return {
    addStyle: (css: string) => addStyle(context, css),
    addElement,
    log: (...args: unknown[]) => {
      console.log(...args);
      void transport.call("log", { text: args.map(String).join(" ") });
    },
    notification: (
      details: string | Record<string, unknown>,
      title?: string,
      image?: string,
      onclick?: () => void,
    ) => {
      const options =
        typeof details === "string" ? { text: details, title, image, onclick } : details;
      const { onclick: click, ondone, ...rest } = options as Record<string, unknown>;
      return transport.call("notify", rest).then((clicked) => {
        try {
          if (clicked) (click as (() => void) | undefined)?.();
          (ondone as ((clicked: boolean) => void) | undefined)?.(Boolean(clicked));
        } catch (error) {
          report(error);
        }
        return clicked;
      });
    },
    setClipboard: (
      data: string,
      info?: string | { type?: string; mimetype?: string },
      callback?: () => void,
    ) =>
      transport
        .call("clipboard", {
          data,
          type: typeof info === "string" ? info : (info?.mimetype ?? info?.type),
        })
        .then(() => callback?.()),
    download: (urlOrDetails: string | Record<string, unknown>, name?: string) => {
      const details = typeof urlOrDetails === "string" ? { url: urlOrDetails, name } : urlOrDetails;
      const { onload, onerror, ...rest } = details as Record<string, unknown>;
      return transport
        .call("download", { ...rest, url: new URL(String(rest.url), location.href).href })
        .then(
          (result) => ((onload as ((r: unknown) => void) | undefined)?.(result), result),
          (error: Error) => {
            (onerror as ((e: unknown) => void) | undefined)?.({ error: error.message });
            throw error;
          },
        );
    },
    audio: {
      setMute: (details: { isMuted: boolean }, callback?: () => void) =>
        transport.call("audio.mute", details).then(() => callback?.()),
      getState: (callback?: (state: unknown) => void) =>
        transport.call("audio.state").then((state) => (callback?.(state), state)),
    },
  };
}

/** Every API, by its short name (getValue, xmlhttpRequest, ...). */
export function gmApis(context: GmContext): Api {
  return {
    ...valuesApi(context),
    ...resourcesApi(context),
    ...menuApi(context),
    ...tabsApi(context),
    ...miscApi(context),
    cookie: cookieApi(context),
    xmlhttpRequest: (details: XhrDetails) =>
      xmlHttpRequest(context.transport, details, context.report),
  };
}

const ASYNC_NAMES: Record<string, string> = { xmlhttpRequest: "xmlHttpRequest" };
const SYNC_ONLY = new Set([
  "addValueChangeListener",
  "removeValueChangeListener",
  "registerMenuCommand",
  "unregisterMenuCommand",
  "addElement",
  "addStyle",
  "openInTab",
]);

/** Builds the GM_* functions and the GM object a script may use. */
export function exposeGm(
  context: GmContext,
  info: Record<string, unknown>,
  apis: Api = gmApis(context),
): Record<string, unknown> {
  const { config } = context;
  const granted = (name: string): boolean =>
    config.grantAll ||
    config.grants.includes(`GM_${name}`) ||
    config.grants.includes(`GM.${name}`) ||
    config.grants.includes(`GM.${ASYNC_NAMES[name] ?? name}`);
  const globals: Record<string, unknown> = { GM_info: info };
  const GM: Record<string, unknown> = { info };
  for (const [name, api] of Object.entries(apis)) {
    if (!granted(name)) continue;
    if (name === "xmlhttpRequest") {
      const request = api as (d: XhrDetails) => { abort(): void; promise: Promise<unknown> };
      globals.GM_xmlhttpRequest = (details: XhrDetails) => ({ abort: request(details).abort });
      GM.xmlHttpRequest = (details: XhrDetails) => {
        const started = request(details);
        return Object.assign(started.promise, { abort: started.abort });
      };
      continue;
    }
    globals[`GM_${name}`] = api;
    GM[ASYNC_NAMES[name] ?? name] =
      typeof api === "function" && !SYNC_ONLY.has(name)
        ? (...args: unknown[]) => Promise.resolve((api as (...a: unknown[]) => unknown)(...args))
        : api;
  }
  globals.GM = GM;
  return globals;
}
