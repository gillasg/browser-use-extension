import {
  holdBrowserDebugger,
  onBrowserDebuggerAttached,
  withBrowserDebugger,
} from "./native-browser-session.js";
import { toHar, summarize, type NetworkEntry } from "./native-browser-network-format.js";
import { dryRunActive, setDryRun } from "./native-browser-dry-run.js";
import { onEngineInstall } from "./native-engine-install.js";

// Network recording for learning a site's own APIs. While a tab records, its API traffic is
// kept with full headers (cookies included), the script that made each call, request and
// response bodies (captured as each request finishes, before navigation discards them),
// redirects, WebSocket frames and server-sent events. The debugger stays attached meanwhile.
const MAX_ENTRIES = 1500;
const DEFAULT_MAX_BODY = 1_000_000;
const MAX_TOTAL_BODY = 60_000_000;
const MAX_FRAMES = 200;
const API_TYPES = new Set(["XHR", "Fetch", "EventSource", "WebSocket", "Document"]);
const TEXTUAL = /json|text|javascript|xml|html|graphql|x-www-form-urlencoded|csv|event-stream/i;

interface Recorder {
  entries: Map<string, NetworkEntry>;
  /** Extra-info headers that arrived before their request. */
  early: Map<string, Record<string, unknown>>;
  allTypes: boolean;
  bodies: boolean;
  maxBody: number;
  bodyBytes: number;
}
const recorders = new Map<number, Recorder>();
/** Recordings that were stopped: still readable (list, har, save) until a new start or the tab closes. */
const stopped = new Map<number, Recorder>();
type Params = Record<string, unknown>;

// Runs inside the attach itself, so it talks to the debugger directly.
onBrowserDebuggerAttached(async (tabId) => {
  if (recorders.has(tabId))
    await chrome.debugger.sendCommand({ tabId }, "Network.enable", NETWORK_BUFFERS);
});

onEngineInstall(() => {
  chrome.debugger.onEvent.addListener((source, method, raw) => {
    const tabId = source.tabId;
    const recorder = tabId === undefined ? undefined : recorders.get(tabId);
    if (!recorder || source.sessionId || tabId === undefined) return;
    const params = (raw ?? {}) as Params;
    const handler = HANDLERS[method];
    if (handler) handler(recorder, params, tabId);
  });
});

const HANDLERS: Record<string, (recorder: Recorder, params: Params, tabId: number) => void> = {
  "Network.requestWillBeSent": requestWillBeSent,
  "Network.requestWillBeSentExtraInfo": (recorder, params) =>
    mergeHeaders(recorder, params, "requestHeaders"),
  "Network.responseReceived": responseReceived,
  "Network.responseReceivedExtraInfo": (recorder, params) =>
    mergeHeaders(recorder, params, "responseHeaders"),
  "Network.loadingFinished": loadingFinished,
  "Network.loadingFailed": (recorder, params) => {
    const entry = recorder.entries.get(String(params.requestId));
    if (!entry) return;
    entry.failed = String(params.errorText ?? "failed");
    entry.done = true;
  },
  "Network.webSocketCreated": (recorder, params) =>
    add(recorder, {
      id: String(params.requestId),
      url: String(params.url),
      method: "GET",
      type: "WebSocket",
      startedAt: Date.now(),
      requestHeaders: {},
      ...initiatorOf(params.initiator),
      frames: [],
      done: false,
    }),
  "Network.webSocketHandshakeResponseReceived": (recorder, params) => {
    const entry = recorder.entries.get(String(params.requestId));
    const response = params.response as Params | undefined;
    if (!entry || !response) return;
    entry.status = Number(response.status);
    entry.responseHeaders = headers(response.headers);
  },
  "Network.webSocketFrameSent": (recorder, params) => frame(recorder, params, "sent"),
  "Network.webSocketFrameReceived": (recorder, params) => frame(recorder, params, "received"),
  "Network.webSocketClosed": (recorder, params) => {
    const entry = recorder.entries.get(String(params.requestId));
    if (entry) entry.done = true;
  },
  "Network.eventSourceMessageReceived": (recorder, params) => {
    const entry = recorder.entries.get(String(params.requestId));
    if (!entry) return;
    entry.messages ??= [];
    if (entry.messages.length < MAX_FRAMES)
      entry.messages.push({
        at: Date.now(),
        event: String(params.eventName ?? "message"),
        data: String(params.data ?? "").slice(0, 20_000),
      });
  },
};

function requestWillBeSent(recorder: Recorder, params: Params): void {
  const id = String(params.requestId ?? "");
  const type = String(params.type ?? "Other");
  const request = params.request as Params;
  const existing = recorder.entries.get(id);
  if (existing && params.redirectResponse) {
    const redirect = params.redirectResponse as Params;
    existing.redirects ??= [];
    existing.redirects.push({
      url: existing.url,
      status: Number(redirect.status),
      headers: headers(redirect.headers),
    });
    existing.url = String(request.url);
    existing.method = String(request.method);
    return;
  }
  if (!recorder.allTypes && !API_TYPES.has(type)) return;
  const entry: NetworkEntry = {
    id,
    url: String(request.url),
    method: String(request.method),
    type,
    startedAt: Math.round(Number(params.wallTime ?? Date.now() / 1000) * 1000),
    requestHeaders: headers(request.headers),
    ...initiatorOf(params.initiator),
    done: false,
  };
  if (typeof params.frameId === "string") entry.frameId = params.frameId;
  if (typeof params.documentURL === "string") entry.documentURL = params.documentURL;
  if (typeof request.postData === "string") entry.requestBody = request.postData;
  else if (request.hasPostData) entry.requestBodyPending = true;
  add(recorder, entry);
  const early = recorder.early.get(id);
  if (early) {
    recorder.early.delete(id);
    mergeHeaders(recorder, early, "requestHeaders");
  }
}

function responseReceived(recorder: Recorder, params: Params): void {
  const entry = recorder.entries.get(String(params.requestId));
  const response = params.response as Params | undefined;
  if (!entry || !response) return;
  entry.status = Number(response.status);
  entry.statusText = String(response.statusText ?? "");
  entry.mimeType = String(response.mimeType ?? "");
  entry.responseHeaders = { ...headers(response.headers), ...entry.responseHeaders };
  if (typeof response.protocol === "string") entry.protocol = response.protocol;
}

function loadingFinished(recorder: Recorder, params: Params, tabId: number): void {
  const entry = recorder.entries.get(String(params.requestId));
  if (!entry) return;
  entry.size = Number(params.encodedDataLength ?? 0);
  entry.durationMs = Math.max(0, Date.now() - entry.startedAt);
  entry.done = true;
  if (recorder.bodies) void captureBodies(tabId, recorder, entry);
}

/** Fetches the response body (and an omitted request body) while the browser still has them. */
async function captureBodies(tabId: number, recorder: Recorder, entry: NetworkEntry) {
  const textual = TEXTUAL.test(entry.mimeType ?? "") || entry.type === "Fetch";
  if (entry.requestBodyPending) {
    const post = await command(tabId, "Network.getRequestPostData", { requestId: entry.id });
    if (typeof post?.postData === "string") entry.requestBody = post.postData;
    delete entry.requestBodyPending;
  }
  if (!textual || (entry.size ?? 0) > recorder.maxBody * 2) return;
  const result = await command(tabId, "Network.getResponseBody", { requestId: entry.id });
  if (typeof result?.body !== "string") return;
  const text = result.base64Encoded ? "" : result.body;
  if (result.base64Encoded) entry.bodyBase64 = true;
  entry.bodyBytes = text.length;
  entry.body = text.length > recorder.maxBody ? text.slice(0, recorder.maxBody) : text;
  if (text.length > recorder.maxBody) entry.bodyTruncated = true;
  recorder.bodyBytes += entry.body.length;
  trimBodies(recorder);
}

function command(
  tabId: number,
  method: string,
  params: Params,
): Promise<{ body?: string; base64Encoded?: boolean; postData?: string } | undefined> {
  return chrome.debugger
    .sendCommand({ tabId }, method, params)
    .then((value) => value as { body?: string; base64Encoded?: boolean; postData?: string })
    .catch(() => undefined);
}

/** Keeps memory bounded: the oldest bodies go first, their requests stay listed. */
function trimBodies(recorder: Recorder): void {
  for (const entry of recorder.entries.values()) {
    if (recorder.bodyBytes <= MAX_TOTAL_BODY) return;
    if (!entry.body) continue;
    recorder.bodyBytes -= entry.body.length;
    delete entry.body;
    entry.bodyDropped = true;
  }
}

function add(recorder: Recorder, entry: NetworkEntry): void {
  recorder.entries.set(entry.id, entry);
  for (const [key, old] of recorder.entries) {
    if (recorder.entries.size <= MAX_ENTRIES) break;
    recorder.bodyBytes -= old.body?.length ?? 0;
    recorder.entries.delete(key);
  }
}

function mergeHeaders(
  recorder: Recorder,
  params: Params,
  field: "requestHeaders" | "responseHeaders",
): void {
  const id = String(params.requestId ?? "");
  const entry = recorder.entries.get(id);
  if (!entry) {
    if (field === "requestHeaders" && recorder.early.size < 500) recorder.early.set(id, params);
    return;
  }
  entry[field] = { ...entry[field], ...headers(params.headers) };
}

function frame(recorder: Recorder, params: Params, direction: "sent" | "received"): void {
  const entry = recorder.entries.get(String(params.requestId));
  const response = params.response as Params | undefined;
  if (!entry?.frames || !response || entry.frames.length >= MAX_FRAMES) return;
  entry.frames.push({
    direction,
    at: Date.now(),
    opcode: Number(response.opcode),
    data: String(response.payloadData ?? "").slice(0, 20_000),
  });
}

function headers(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (!value || typeof value !== "object") return result;
  for (const [name, item] of Object.entries(value as Params)) result[name] = String(item);
  return result;
}

function initiatorOf(value: unknown): Pick<NetworkEntry, "initiator"> {
  const initiator = value as Params | undefined;
  if (!initiator) return {};
  const frames: { url: string; functionName: string; line: number }[] = [];
  let stack = initiator.stack as Params | undefined;
  while (stack && frames.length < 12) {
    for (const call of (stack.callFrames as Params[] | undefined) ?? []) {
      if (frames.length >= 12) break;
      frames.push({
        url: String(call.url ?? ""),
        functionName: String(call.functionName ?? ""),
        line: Number(call.lineNumber ?? 0) + 1,
      });
    }
    stack = stack.parent as Params | undefined;
  }
  const result: NonNullable<NetworkEntry["initiator"]> = { type: String(initiator.type ?? "") };
  if (typeof initiator.url === "string") result.url = initiator.url;
  if (frames.length) result.stack = frames;
  return { initiator: result };
}

onEngineInstall(() => {
  chrome.tabs.onRemoved.addListener((tabId) => {
    recorders.delete(tabId);
    stopped.delete(tabId);
    holdBrowserDebugger(tabId, false);
  });
});

const NETWORK_BUFFERS = {
  maxTotalBufferSize: 100_000_000,
  maxResourceBufferSize: 10_000_000,
  maxPostDataSize: 1_000_000,
};

async function enableNetwork(tabId: number): Promise<void> {
  await withBrowserDebugger(tabId, (debuggee) =>
    chrome.debugger.sendCommand(debuggee, "Network.enable", NETWORK_BUFFERS),
  );
}

export async function networkCall(
  tabId: number,
  action: string,
  options: Params,
): Promise<unknown> {
  if (action === "start") return start(tabId, options);
  if (action === "stop") {
    await setDryRun(tabId, false);
    holdBrowserDebugger(tabId, false);
    const active = recorders.get(tabId);
    if (active) stopped.set(tabId, active);
    return { stopped: recorders.delete(tabId) };
  }
  const recorder = recorders.get(tabId) ?? stopped.get(tabId);
  if (!recorder) throw new Error("Not recording: call page.network.start() first");
  if (action === "list") return list(recorder, options);
  if (action === "get") return entryOf(recorder, options.id);
  if (action === "body") return bodyOf(tabId, recorder, options.id);
  if (action === "har") return toHar([...recorder.entries.values()]);
  if (action === "clear") {
    recorder.entries.clear();
    recorder.bodyBytes = 0;
    return { cleared: true };
  }
  throw new Error("UNSUPPORTED: page.network." + action);
}

async function start(tabId: number, options: Params): Promise<unknown> {
  const recorder: Recorder = recorders.get(tabId) ??
    stopped.get(tabId) ?? {
      entries: new Map(),
      early: new Map(),
      allTypes: false,
      bodies: true,
      maxBody: DEFAULT_MAX_BODY,
      bodyBytes: 0,
    };
  if (options.types !== undefined) recorder.allTypes = options.types === "all";
  if (options.bodies !== undefined) recorder.bodies = options.bodies !== false;
  if (typeof options.maxBodyBytes === "number" && options.maxBodyBytes > 0)
    recorder.maxBody = Math.min(options.maxBodyBytes, 10_000_000);
  stopped.delete(tabId);
  recorders.set(tabId, recorder);
  holdBrowserDebugger(tabId, true);
  await enableNetwork(tabId);
  if (options.dryRun !== undefined) await setDryRun(tabId, options.dryRun === true);
  return {
    recording: true,
    types: recorder.allTypes ? "all" : "api",
    bodies: recorder.bodies,
    dryRun: dryRunActive(tabId),
  };
}

function list(recorder: Recorder, options: Params): unknown[] {
  const match = typeof options.match === "string" && options.match ? options.match : undefined;
  const method = typeof options.method === "string" ? options.method.toUpperCase() : undefined;
  return [...recorder.entries.values()]
    .filter((entry) => !match || entry.url.includes(match))
    .filter((entry) => !method || entry.method === method)
    .filter((entry) => typeof options.type !== "string" || entry.type === options.type)
    .map(summarize);
}

function entryOf(recorder: Recorder, id: unknown): NetworkEntry {
  const entry = recorder.entries.get(String(id ?? ""));
  if (!entry) throw new Error("Unknown request id: use an id from page.network.list()");
  return entry;
}

async function bodyOf(tabId: number, recorder: Recorder, id: unknown): Promise<unknown> {
  const entry = entryOf(recorder, id);
  if (!entry.done) throw new Error("That request is still loading; try again shortly");
  if (entry.body === undefined && !entry.bodyBase64) await captureBodies(tabId, recorder, entry);
  if (entry.bodyBase64) return { binary: true, bytes: entry.size ?? 0 };
  if (entry.body === undefined)
    return { unavailable: true, reason: entry.bodyDropped ? "dropped to save memory" : "no body" };
  if (!entry.bodyTruncated) {
    try {
      return JSON.parse(entry.body) as unknown;
    } catch {
      // Not JSON: return the text.
    }
  }
  return {
    text: entry.body,
    ...(entry.bodyTruncated ? { truncated: true, length: entry.bodyBytes } : {}),
  };
}
