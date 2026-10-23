import { exposeGm, gmApis, type ScriptConfig } from "./gm.js";
import { sbHelpers, type ValueStore } from "./sb.js";
import { Tracker } from "./tracker.js";
import { eventTransport, portTransport, startBridge } from "./transport.js";

// The runtime every script gets, built into a self-contained string the service worker puts in
// front of each script's code. `start` returns the names the script sees as globals.

export type { ScriptConfig };

/** Names the wrapper declares for the script, whether or not they are granted. */
export const GLOBAL_NAMES = [
  "GM",
  "GM_info",
  "GM_getValue",
  "GM_setValue",
  "GM_deleteValue",
  "GM_listValues",
  "GM_getValues",
  "GM_setValues",
  "GM_deleteValues",
  "GM_addValueChangeListener",
  "GM_removeValueChangeListener",
  "GM_getResourceText",
  "GM_getResourceURL",
  "GM_registerMenuCommand",
  "GM_unregisterMenuCommand",
  "GM_getTab",
  "GM_saveTab",
  "GM_getTabs",
  "GM_openInTab",
  "GM_addStyle",
  "GM_addElement",
  "GM_log",
  "GM_notification",
  "GM_setClipboard",
  "GM_download",
  "GM_audio",
  "GM_cookie",
  "GM_xmlhttpRequest",
  "SB",
  "unsafeWindow",
];

function watchUrl(): void {
  let last = location.href;
  const check = (): void => {
    if (location.href === last) return;
    last = location.href;
    const event = Object.assign(new Event("urlchange"), { url: last });
    window.dispatchEvent(event);
    const handler = (window as unknown as { onurlchange?: unknown }).onurlchange;
    if (typeof handler === "function") (handler as (e: Event) => void)(event);
  };
  addEventListener("popstate", check);
  addEventListener("hashchange", check);
  setInterval(check, 300);
}

export function start(config: ScriptConfig): Record<string, unknown> {
  const transport =
    config.world === "page" ? eventTransport(config.nonce) : portTransport(`sb:${config.id}`);
  const name = String((config.info.script as { name?: string } | undefined)?.name ?? config.id);
  const tracker = new Tracker(transport);
  const report = (error: unknown): void => {
    console.error(`[Site Boosts] ${name}:`, error);
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    tracker.error(message);
    void transport
      .call("log", {
        level: "error",
        text: message,
        stack: error instanceof Error ? error.stack : undefined,
      })
      .catch(() => undefined);
  };
  const context = { config, transport, tracker, report };
  const apis = gmApis(context);
  const globals = exposeGm(context, config.info, apis);
  globals.SB = sbHelpers(context, apis as unknown as ValueStore);
  globals.unsafeWindow = window;
  globals.__report = report;
  if (config.grantAll || config.grants.includes("window.onurlchange")) watchUrl();
  void transport.call("started").catch(() => undefined);
  return globals;
}

/** The isolated-world half for page-world scripts. */
export function bridge(nonce: string, id: string): void {
  startBridge(nonce, `sb:${id}`);
}
