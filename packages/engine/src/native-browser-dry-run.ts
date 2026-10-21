import { withBrowserDebugger } from "./native-browser-session.js";

// Dry run: while a tab records with {dryRun: true}, requests that would change something (a like,
// a message, a post, a purchase) are answered by the browser itself with an empty success and never
// reach the site. The recorder still sees them, request and all, so the action can be mapped
// without doing it. Reads (GET, searches, GraphQL queries) go through untouched.
const dryRunTabs = new Set<number>();
export const DRY_RUN_HEADER = "x-dry-run";
type Params = Record<string, unknown>;

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
// Default to write. A GET/HEAD is a read only when its path does not change state; a GraphQL
// query is a read. Anything uncertain is blocked in a dry run: a missed read leaves a gap in
// the map, a passed write really happens.
const STATE_CHANGING_PATH =
  /(^|\/)(logout|signout|sign-out|unsubscribe|delete|remove|destroy|archive|block|mute|like|unlike|follow|unfollow|vote|report|send|submit|create|update|edit|save|add|checkout|order|buy|pay|purchase|book|reserve|cancel|refund|invite|accept|reject|approve|join|leave|upload|post|comment|reply|message|share|subscribe)(\/|$)/i;

/** True when a request only reads: reads go through even during a dry run. */
export function looksLikeRead(method: string, url: string, body?: string): boolean {
  if (body && /\bmutation\b/.test(body)) return false;
  if (body && /"query"\s*:\s*"\s*(query\b|\{)/.test(body)) return true;
  if (body && /"query"\s*:/.test(body)) return false;
  if (!READ_METHODS.has(method.toUpperCase())) return false;
  try {
    return !STATE_CHANGING_PATH.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

chrome.debugger.onEvent.addListener((source, method, raw) => {
  const tabId = source.tabId;
  if (method !== "Fetch.requestPaused" || tabId === undefined || !dryRunTabs.has(tabId)) return;
  void answer(tabId, source.sessionId, (raw ?? {}) as Params);
});

async function answer(tabId: number, sessionId: string | undefined, params: Params): Promise<void> {
  const request = (params.request ?? {}) as Params;
  const requestId = String(params.requestId);
  const debuggee = sessionId ? { tabId, sessionId } : { tabId };
  const read = looksLikeRead(
    String(request.method ?? "GET"),
    String(request.url ?? ""),
    typeof request.postData === "string" ? request.postData : undefined,
  );
  const send = (command: string, body: Params) =>
    chrome.debugger.sendCommand(debuggee, command, body).catch(() => undefined);
  if (read) return void (await send("Fetch.continueRequest", { requestId }));
  await send("Fetch.fulfillRequest", {
    requestId,
    responseCode: 200,
    responseHeaders: [
      { name: "content-type", value: "application/json" },
      { name: DRY_RUN_HEADER, value: "blocked" },
    ],
    body: btoa("{}"),
  });
}

const PATTERNS = ["XHR", "Fetch", "Document", "Ping", "Other"].map((resourceType) => ({
  urlPattern: "*",
  resourceType,
  requestStage: "Request",
}));

export async function setDryRun(tabId: number, enabled: boolean): Promise<void> {
  if (enabled === dryRunTabs.has(tabId)) return;
  if (enabled) dryRunTabs.add(tabId);
  else dryRunTabs.delete(tabId);
  await withBrowserDebugger(tabId, (debuggee) =>
    chrome.debugger.sendCommand(
      debuggee,
      enabled ? "Fetch.enable" : "Fetch.disable",
      enabled ? { patterns: PATTERNS } : {},
    ),
  ).catch(() => undefined);
}

export const dryRunActive = (tabId: number): boolean => dryRunTabs.has(tabId);

chrome.tabs.onRemoved.addListener((tabId) => dryRunTabs.delete(tabId));
