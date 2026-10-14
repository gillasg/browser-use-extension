// GM_xmlhttpRequest in the service worker: fetch with the person's cookies, headers fetch() cannot
// set (Cookie, Referer, User-Agent, Origin) applied through a short-lived network rule, progress
// events, timeouts and cancelling.

export interface XhrArgs {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  data?:
    | string
    | { kind: "text"; text: string; type?: string }
    | { kind: "bytes"; base64: string; type?: string }
    | { kind: "form"; entries: FormEntry[] };
  timeout?: number;
  anonymous?: boolean;
  redirect?: "follow" | "error" | "manual";
  overrideMimeType?: string;
  user?: string;
  password?: string;
}

type FormEntry =
  | { name: string; value: string }
  | { name: string; file: string; filename?: string; type?: string };

type Emit = (event: string, data?: unknown) => void;

const FORBIDDEN = new Set([
  "cookie",
  "referer",
  "user-agent",
  "origin",
  "host",
  "connection",
  "content-length",
  "accept-encoding",
  "sec-fetch-site",
  "sec-fetch-mode",
  "sec-fetch-dest",
]);

const fromBase64 = (text: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function body(data: XhrArgs["data"], headers: Headers): BodyInit | undefined {
  if (data === undefined || data === null) return undefined;
  if (typeof data === "string") return data;
  if (data.kind === "text") {
    if (data.type && !headers.has("content-type")) headers.set("content-type", data.type);
    return data.text;
  }
  if (data.kind === "bytes") {
    if (data.type && !headers.has("content-type")) headers.set("content-type", data.type);
    return fromBase64(data.base64);
  }
  const form = new FormData();
  for (const entry of data.entries) {
    if ("value" in entry) form.append(entry.name, entry.value);
    else
      form.append(
        entry.name,
        new Blob([fromBase64(entry.file)], { type: entry.type }),
        entry.filename,
      );
  }
  return form;
}

let nextRule = 1;

/** Headers fetch() refuses to set go on a one-request network rule instead. */
async function withSpecialHeaders<T>(
  url: string,
  special: [string, string][],
  run: () => Promise<T>,
): Promise<T> {
  if (!special.length) return run();
  const id = 900_000 + (nextRule++ % 90_000);
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [id],
    addRules: [
      {
        id,
        priority: 5,
        action: {
          type: "modifyHeaders" as chrome.declarativeNetRequest.RuleActionType,
          requestHeaders: special.map(([header, value]) => ({
            header,
            operation: "set" as chrome.declarativeNetRequest.HeaderOperation,
            value,
          })),
        },
        condition: {
          urlFilter: `|${url.split("#")[0]}|`,
          tabIds: [chrome.tabs.TAB_ID_NONE],
          resourceTypes: [
            "xmlhttprequest" as chrome.declarativeNetRequest.ResourceType,
            "other" as chrome.declarativeNetRequest.ResourceType,
          ],
        },
      },
    ],
  });
  try {
    return await run();
  } finally {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] });
  }
}

function headerText(headers: Headers): string {
  return [...headers].map(([name, value]) => `${name}: ${value}`).join("\r\n");
}

async function readBody(
  response: Response,
  emit: Emit,
  base: Record<string, unknown>,
): Promise<Uint8Array> {
  const total = Number(response.headers.get("content-length")) || undefined;
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  let lastEmit = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    if (Date.now() - lastEmit > 100) {
      lastEmit = Date.now();
      emit("progress", { ...base, loaded, total });
    }
  }
  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Headers fetch() may set, and the ones it may not (sent through a network rule instead). */
function splitHeaders(args: XhrArgs): { headers: Headers; special: [string, string][] } {
  const headers = new Headers();
  const special: [string, string][] = [];
  for (const [name, value] of Object.entries(args.headers ?? {})) {
    if (FORBIDDEN.has(name.toLowerCase())) special.push([name, String(value)]);
    else headers.set(name, String(value));
  }
  if (args.user)
    headers.set("authorization", "Basic " + btoa(`${args.user}:${args.password ?? ""}`));
  return { headers, special };
}

/** Runs one request, reporting headers, progress and the result through `emit`. */
export async function runXhr(args: XhrArgs, emit: Emit, signal: AbortSignal): Promise<void> {
  const { headers, special } = splitHeaders(args);
  const controller = new AbortController();
  signal.addEventListener("abort", () => controller.abort());
  let timedOut = false;
  const timer = args.timeout
    ? setTimeout(() => ((timedOut = true), controller.abort()), args.timeout)
    : undefined;
  try {
    const response = await withSpecialHeaders(args.url, special, () =>
      fetch(args.url, {
        method: args.method ?? "GET",
        headers,
        body: body(args.data, headers),
        credentials: args.anonymous ? "omit" : "include",
        redirect: args.redirect ?? "follow",
        signal: controller.signal,
      }),
    );
    const base = {
      status: response.status,
      statusText: response.statusText,
      headers: headerText(response.headers),
      finalUrl: response.url || args.url,
    };
    emit("headers", base);
    const bytes = await readBody(response, emit, base);
    const mime = args.overrideMimeType ?? response.headers.get("content-type") ?? "text/plain";
    emit("load", {
      ...base,
      mime,
      body: toBase64(bytes),
      loaded: bytes.length,
      total: bytes.length,
    });
  } catch (error) {
    if (signal.aborted) return;
    emit(timedOut ? "timeout" : "error", {
      status: 0,
      statusText: "",
      headers: "",
      finalUrl: args.url,
      mime: "",
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (timer) clearTimeout(timer);
    emit("done");
  }
}

/** Whether a script may reach a URL: its @connect list, its own page's host, or anything for boosts. */
export function mayConnect(
  url: string,
  pageUrl: string | undefined,
  connect: string[] | undefined,
): boolean {
  if (connect === undefined) return true;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  const pageHost = pageUrl ? new URL(pageUrl).hostname : "";
  if (host === pageHost) return true;
  return connect.some((entry) => {
    const rule = entry.trim().toLowerCase();
    if (rule === "*") return true;
    if (rule === "self") return host === pageHost;
    if (rule === "localhost")
      return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
    return host === rule || host.endsWith("." + rule.replace(/^\*\./, ""));
  });
}
