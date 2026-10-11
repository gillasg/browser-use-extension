import { withBrowserDebugger } from "./native-browser-session.js";

// Network recording for learning a site's own APIs: while recording, a tab's fetch/XHR traffic
// is kept (newest 300 requests), so the agent can find the JSON endpoints behind a flow and
// save them as a site skill that calls them directly next time.
const MAX_ENTRIES = 300;
const MAX_BODY = 200_000;

interface Entry {
  id: string;
  url: string;
  method: string;
  type: string;
  postData?: string;
  status?: number;
  mimeType?: string;
  size?: number;
  failed?: string;
  done: boolean;
}
interface Recorder {
  entries: Map<string, Entry>;
  detached: boolean;
}
const recorders = new Map<number, Recorder>();

chrome.debugger.onEvent.addListener((source, method, raw) => {
  const recorder = source.tabId === undefined ? undefined : recorders.get(source.tabId);
  if (!recorder || source.sessionId) return;
  const params = (raw ?? {}) as Record<string, unknown>;
  if (method === "Network.requestWillBeSent") record(recorder, params);
  else update(recorder.entries.get(String(params.requestId ?? "")), method, params);
});

function record(recorder: Recorder, params: Record<string, unknown>): void {
  const type = String(params.type ?? "");
  if (type !== "XHR" && type !== "Fetch") return;
  const id = String(params.requestId ?? "");
  const request = params.request as { url: string; method: string; postData?: string };
  recorder.entries.set(id, {
    id,
    url: request.url,
    method: request.method,
    type,
    ...(request.postData ? { postData: request.postData.slice(0, 4000) } : {}),
    done: false,
  });
  for (const key of recorder.entries.keys()) {
    if (recorder.entries.size <= MAX_ENTRIES) break;
    recorder.entries.delete(key);
  }
}

function update(entry: Entry | undefined, method: string, params: Record<string, unknown>): void {
  if (!entry) return;
  if (method === "Network.responseReceived") {
    const response = params.response as { status: number; mimeType: string };
    entry.status = response.status;
    entry.mimeType = response.mimeType;
  } else if (method === "Network.loadingFinished") {
    entry.size = Number(params.encodedDataLength ?? 0);
    entry.done = true;
  } else if (method === "Network.loadingFailed") {
    entry.failed = String(params.errorText ?? "failed");
    entry.done = true;
  }
}
chrome.debugger.onDetach.addListener((source) => {
  const recorder = source.tabId === undefined ? undefined : recorders.get(source.tabId);
  if (recorder) recorder.detached = true;
});
chrome.tabs.onRemoved.addListener((tabId) => recorders.delete(tabId));

export async function networkCall(
  tabId: number,
  action: string,
  options: { match?: unknown; id?: unknown },
): Promise<unknown> {
  if (action === "start") {
    const recorder = recorders.get(tabId) ?? { entries: new Map(), detached: false };
    recorders.set(tabId, recorder);
    await enable(tabId, recorder);
    return { recording: true };
  }
  if (action === "stop") return { stopped: recorders.delete(tabId) };
  const recorder = recorders.get(tabId);
  if (!recorder) throw new Error("Not recording: call page.network.start() first");
  // An idle tab detaches its debugger; enabling again resumes recording for later traffic.
  if (recorder.detached) await enable(tabId, recorder);
  if (action === "list") return list(recorder, options.match);
  if (action === "body") return body(tabId, recorder, String(options.id ?? ""));
  throw new Error("UNSUPPORTED");
}

async function enable(tabId: number, recorder: Recorder): Promise<void> {
  await withBrowserDebugger(tabId, (debuggee) =>
    chrome.debugger.sendCommand(debuggee, "Network.enable", {}),
  );
  recorder.detached = false;
}

function list(recorder: Recorder, match: unknown): unknown[] {
  const filter = typeof match === "string" && match ? match : undefined;
  return [...recorder.entries.values()]
    .filter((entry) => !filter || entry.url.includes(filter))
    .map((entry) => {
      const { done, ...summary } = entry;
      return {
        ...summary,
        ...(done ? {} : { loading: true }),
        json: /json/i.test(entry.mimeType ?? ""),
      };
    });
}

async function body(tabId: number, recorder: Recorder, id: string): Promise<unknown> {
  const entry = recorder.entries.get(id);
  if (!entry) throw new Error("Unknown request id: use an id from page.network.list()");
  if (!entry.done) throw new Error("That request is still loading; try again shortly");
  const result = (await withBrowserDebugger(tabId, (debuggee) =>
    chrome.debugger.sendCommand(debuggee, "Network.getResponseBody", { requestId: id }),
  )) as { body: string; base64Encoded: boolean };
  if (result.base64Encoded) return { binary: true, bytes: Math.floor(result.body.length * 0.75) };
  const text = result.body.length > MAX_BODY ? result.body.slice(0, MAX_BODY) : result.body;
  const truncated = result.body.length > MAX_BODY;
  try {
    if (!truncated) return JSON.parse(text) as unknown;
  } catch {
    /* Not JSON: return the text. */
  }
  return { text, ...(truncated ? { truncated: true, length: result.body.length } : {}) };
}
