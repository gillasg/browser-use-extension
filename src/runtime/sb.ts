import type { GmContext } from "./gm.js";
import { xmlHttpRequest } from "./xhr.js";

// SB: small helpers for boosts written in JavaScript (by a person or a model).

interface PanelOptions {
  title?: string;
  html: string;
  /** Put the panel inside this element (or selector); floating when left out. */
  anchor?: Element | string;
  position?: "before" | "after" | "prepend" | "append";
}

const PANEL_CSS = `
:host { all: initial; }
.panel { font: 13px/1.45 system-ui, sans-serif; color: #1b1b1f; background: #fff; border: 1px solid #d9d9e0;
  border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,.12); padding: 10px 12px; max-width: 420px; }
.floating { position: fixed; right: 16px; bottom: 64px; z-index: 2147483646; }
.title { font-weight: 600; margin: 0 0 6px; display: flex; justify-content: space-between; gap: 8px; }
.close { all: unset; cursor: pointer; opacity: .6; }
table { border-collapse: collapse; } td, th { padding: 2px 6px; text-align: left; }
a { color: #3a5ccc; }
@media (prefers-color-scheme: dark) { .panel { color: #ececf1; background: #1f1f24; border-color: #3a3a44; } a { color: #9db2ff; } }
`;

export interface ValueStore {
  getValue(key: string, fallback?: unknown): unknown;
  setValue(key: string, value: unknown): void;
}

function waitFor(selector: string, timeoutMs = 10000): Promise<Element> {
  return new Promise((resolve, reject) => {
    const found = document.querySelector(selector);
    if (found) return resolve(found);
    const observer = new MutationObserver(() => {
      const element = document.querySelector(selector);
      if (!element) return;
      observer.disconnect();
      resolve(element);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => {
      observer.disconnect();
      reject(new Error(`Nothing matched ${selector}`));
    }, timeoutMs);
  });
}

function placePanel(host: HTMLElement, options: PanelOptions): void {
  const anchor =
    typeof options.anchor === "string" ? document.querySelector(options.anchor) : options.anchor;
  if (!anchor) document.documentElement.append(host);
  else if (options.position === "before") anchor.before(host);
  else if (options.position === "after") anchor.after(host);
  else if (options.position === "prepend") anchor.prepend(host);
  else anchor.append(host);
}

/** A styled panel in its own shadow root, so the page's styles cannot reach it. */
function panel(options: PanelOptions): HTMLElement {
  const host = document.createElement("site-boosts-panel");
  const root = host.attachShadow({ mode: "open" });
  const style = new CSSStyleSheet();
  style.replaceSync(PANEL_CSS);
  root.adoptedStyleSheets = [style];
  const box = document.createElement("div");
  box.className = "panel" + (options.anchor ? "" : " floating");
  const title = document.createElement("div");
  title.className = "title";
  title.textContent = options.title ?? "";
  const close = document.createElement("button");
  close.className = "close";
  close.textContent = "×";
  close.onclick = () => host.remove();
  title.append(close);
  const body = document.createElement("div");
  body.innerHTML = options.html;
  box.append(...(options.title ? [title] : []), body);
  root.append(box);
  placePanel(host, options);
  return body;
}

export function sbHelpers(context: GmContext, store: ValueStore): Record<string, unknown> {
  const { transport, report, tracker } = context;

  function onElement(selector: string, callback: (element: Element) => void): () => void {
    const seen = new WeakSet<Element>();
    tracker.watch(selector);
    const scan = (): void => {
      for (const element of document.querySelectorAll(selector)) {
        if (seen.has(element)) continue;
        seen.add(element);
        tracker.found(selector, element);
        try {
          callback(element);
        } catch (error) {
          report(error);
        }
      }
    };
    scan();
    const observer = new MutationObserver(scan);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    return () => observer.disconnect();
  }

  async function sbFetch(
    url: string,
    options: {
      method?: string;
      headers?: Record<string, string>;
      body?: unknown;
      as?: "json" | "text" | "html";
    } = {},
  ): Promise<unknown> {
    const response = await xmlHttpRequest(
      transport,
      {
        url: new URL(url, location.href).href,
        method: options.method,
        headers: options.headers,
        data: options.body,
        responseType: options.as === "json" ? "json" : "text",
      },
      report,
    ).promise;
    if (response.status >= 400) throw new Error(`${response.status} from ${url}`);
    if (options.as === "html")
      return new DOMParser().parseFromString(response.responseText, "text/html");
    if (options.as === "json") return response.response;
    return response.responseText;
  }

  return {
    onElement,
    waitFor,
    panel,
    fetch: sbFetch,
    api: (site: string, operation: string, params: Record<string, unknown> = {}) =>
      transport.call("api", { site, operation, params }),
    get: (key: string, fallback?: unknown) => store.getValue(key, fallback),
    set: (key: string, value: unknown) => store.setValue(key, value),
    notify: (text: string, title?: string) => transport.call("notify", { text, title }),
    companion: (kind: string, data: unknown) => transport.call("companion", { kind, data }),
    report,
  };
}
