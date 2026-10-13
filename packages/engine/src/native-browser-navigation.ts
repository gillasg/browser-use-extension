import { noteDeviceEmulation } from "./native-browser-session.js";
import type { BrowserExecutorRequest } from "@aeon/protocol";
import { BrowserActionError } from "./native-browser-common.js";

interface Activity {
  pending: Map<string, number>;
  last: number;
}
export interface PageProbe {
  ready: string;
  idle: number;
  url: string;
  document: string;
  changes: number;
}
export interface PageSettle {
  why: "quiet" | "cap" | "error";
  ms: number;
  pending: number;
  probe?: PageProbe;
}
const activity = new Map<number, Activity>();
export function trackBrowserActivity(tabId: number): void {
  activity.set(tabId, { pending: new Map(), last: 0 });
}
export function forgetBrowserActivity(tabId: number): void {
  activity.delete(tabId);
}
chrome.debugger.onEvent.addListener((source, method, raw) => {
  if (source.tabId === undefined) return;
  const state = activity.get(source.tabId);
  if (!state) return;
  const data = (raw ?? {}) as { requestId?: string; type?: string; defaultPrompt?: string };
  if (method === "Page.javascriptDialogOpening")
    void chrome.debugger
      .sendCommand(source, "Page.handleJavaScriptDialog", {
        accept: true,
        promptText: data.defaultPrompt ?? "",
      })
      .catch(() => undefined);
  captureNetworkActivity(state, (source.sessionId ?? "") + ":" + data.requestId, method, data.type);
});
function captureNetworkActivity(state: Activity, key: string, method: string, type?: string) {
  if (method === "Network.requestWillBeSent") {
    if (["WebSocket", "EventSource", "Media", "Ping", "Manifest"].includes(type ?? "")) return;
    state.pending.set(key, Date.now());
    if (state.pending.size > 1000) state.pending.delete(state.pending.keys().next().value ?? "");
    state.last = Date.now();
  } else if (
    ["Network.loadingFinished", "Network.loadingFailed"].includes(method) &&
    state.pending.delete(key)
  )
    state.last = Date.now();
}
export function primeBrowserSettle(
  debuggee: chrome.debugger.Debuggee,
): Promise<PageProbe | undefined> {
  return probe(debuggee).catch(() => undefined);
}
function networkState(tabId: number) {
  const net = activity.get(tabId);
  return {
    pending: [...(net?.pending.values() ?? [])].filter((at) => Date.now() - at < 1500).length,
    quiet: Date.now() - (net?.last ?? 0) >= 80,
  };
}
export async function settleBrowserPage(
  debuggee: chrome.debugger.Debuggee,
  capMs = 800,
  since = Date.now(),
  minQuietMs = 80,
): Promise<PageSettle> {
  const start = Date.now();
  let limit = capMs,
    pending = 0,
    state: PageProbe | undefined;
  while (Date.now() - start < limit) {
    try {
      state = await probe(debuggee);
      if (state?.ready === "loading") limit = Math.max(capMs, 3000);
      const net = networkState(debuggee.tabId ?? -1);
      pending = net.pending;
      if (isQuiet(state, net, since, minQuietMs))
        return { why: "quiet", ms: Date.now() - start, pending, probe: state };
    } catch (error) {
      if (!/context|navigat|frame/i.test(String(error)))
        return { why: "error", ms: Date.now() - start, pending };
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return { why: "cap", ms: Date.now() - start, pending, ...(state ? { probe: state } : {}) };
}
function isQuiet(
  state: PageProbe | undefined,
  net: { pending: number; quiet: boolean },
  since: number,
  minQuietMs: number,
): state is PageProbe {
  return (
    !!state &&
    state.ready !== "loading" &&
    Math.min(state.idle, Date.now() - since) >= minQuietMs &&
    !net.pending &&
    net.quiet
  );
}
export function pageOutcome(
  before: PageProbe | undefined,
  after: PageProbe | undefined,
): "navigated" | "changed" | "unchanged" | "unknown" {
  if (!before || !after) return "unknown";
  if (before.document !== after.document || before.url !== after.url) return "navigated";
  return before.changes !== after.changes ? "changed" : "unchanged";
}
async function probe(debuggee: chrome.debugger.Debuggee): Promise<PageProbe | undefined> {
  const result = (await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
    expression: `(${domQuietProbe.toString()})()`,
    returnByValue: true,
  })) as { result?: { value?: PageProbe }; exceptionDetails?: unknown };
  if (result.exceptionDetails) throw new Error("Execution context changed");
  return result.result?.value;
}
function domQuietProbe() {
  const host = window as unknown as {
    __aeonQuiet?: { last: number; changes: number; document: string; observer: MutationObserver };
  };
  if (!host.__aeonQuiet) {
    const state = {
      last: performance.now(),
      changes: 0,
      document: Math.random().toString(36),
      observer: undefined as unknown as MutationObserver,
    };
    const styles = new WeakMap<Node, number>();
    state.observer = new MutationObserver((records) => {
      const now = performance.now();
      for (const record of records) {
        if (ownOverlay(record)) continue;
        if (unchangedAttribute(record)) continue;
        if (record.attributeName === "style") {
          const previous = styles.get(record.target) ?? -Infinity;
          styles.set(record.target, now);
          if (now - previous < 200) continue;
        }
        state.last = now;
        state.changes++;
      }
    });
    state.observer.observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeOldValue: true,
      characterData: true,
    });
    const changed = () => {
      state.last = performance.now();
      state.changes++;
    };
    document.addEventListener("input", changed, true);
    document.addEventListener("change", changed, true);
    host.__aeonQuiet = state;
  }
  return {
    ready: document.readyState,
    idle: performance.now() - host.__aeonQuiet.last,
    url: location.href,
    document: host.__aeonQuiet.document,
    changes: host.__aeonQuiet.changes,
  };
  function ownOverlay(record: MutationRecord) {
    return !!(record.target as Element).closest?.("[data-aeon-overlay]");
  }
  function unchangedAttribute(record: MutationRecord) {
    return (
      !!record.attributeName &&
      record.oldValue === (record.target as Element).getAttribute(record.attributeName)
    );
  }
}

export async function waitPageInteractive(tabId: number, timeoutMs = 2000): Promise<boolean> {
  return (await settleBrowserPage({ tabId }, timeoutMs)).why === "quiet";
}

export async function viewportFingerprint(debuggee: chrome.debugger.Debuggee): Promise<string> {
  const result = (await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
    expression: `(${layoutProbe.toString()})()`,
    returnByValue: true,
  })) as { result?: { value?: string }; exceptionDetails?: unknown };
  if (result.exceptionDetails || typeof result.result?.value !== "string" || !result.result.value)
    throw new Error("STALE_REF");
  return result.result.value;
}
function layoutProbe(): string {
  const elements = [...document.querySelectorAll("*")];
  const boxes: unknown[] = [];
  for (const el of elements) {
    const box = el.getBoundingClientRect();
    if (
      box.width <= 0 ||
      box.height <= 0 ||
      box.bottom < 0 ||
      box.top > innerHeight ||
      box.right < 0 ||
      box.left > innerWidth ||
      getComputedStyle(el).visibility === "hidden"
    )
      continue;
    boxes.push([
      el.tagName,
      el.id,
      el.getAttribute("aria-label"),
      el.getAttribute("href"),
      (el.textContent ?? "").trim().slice(0, 80),
      ...[box.x, box.y, box.width, box.height].map(Math.round),
    ]);
    if (boxes.length >= 2000) return "";
  }
  return JSON.stringify([scrollX, scrollY, innerWidth, innerHeight, visualViewport?.scale, boxes]);
}

export async function navigateReady(
  tabId: number,
  url: string,
  timeoutMs = 8000,
): Promise<{ url: string; timedOut: boolean }> {
  const navigation = await new Promise<{ url: string; timedOut: boolean }>((resolve, reject) => {
    let committed = false;
    const top = (event: { tabId: number; frameId: number }) =>
      event.tabId === tabId && event.frameId === 0;
    const clean = () => {
      clearTimeout(timer);
      chrome.webNavigation.onCommitted.removeListener(commit);
      chrome.webNavigation.onDOMContentLoaded.removeListener(ready);
      chrome.webNavigation.onErrorOccurred.removeListener(error);
      chrome.webNavigation.onHistoryStateUpdated.removeListener(sameDocument);
      chrome.webNavigation.onReferenceFragmentUpdated.removeListener(sameDocument);
    };
    const finish = (nextUrl: string, timedOut = false) => {
      clean();
      resolve({ url: nextUrl, timedOut });
    };
    const commit = (event: chrome.webNavigation.WebNavigationTransitionCallbackDetails) => {
      if (top(event)) committed = true;
    };
    const ready = (event: chrome.webNavigation.WebNavigationFramedCallbackDetails) => {
      if (top(event) && committed) finish(event.url);
    };
    const sameDocument = (event: chrome.webNavigation.WebNavigationTransitionCallbackDetails) => {
      if (top(event)) finish(event.url);
    };
    const error = (event: chrome.webNavigation.WebNavigationFramedErrorCallbackDetails) => {
      if (top(event) && !event.error.includes("ERR_ABORTED")) {
        clean();
        reject(new Error("OPERATION_FAILED"));
      }
    };
    const timer = setTimeout(
      () => {
        clean();
        void chrome.tabs
          .get(tabId)
          .then((tab) => resolve({ url: tab.url ?? url, timedOut: true }), reject);
      },
      Math.max(100, timeoutMs - 2000),
    );
    chrome.webNavigation.onCommitted.addListener(commit);
    chrome.webNavigation.onDOMContentLoaded.addListener(ready);
    chrome.webNavigation.onErrorOccurred.addListener(error);
    chrome.webNavigation.onHistoryStateUpdated.addListener(sameDocument);
    chrome.webNavigation.onReferenceFragmentUpdated.addListener(sameDocument);
    void chrome.tabs.update(tabId, { url }).catch((cause) => {
      clean();
      reject(cause);
    });
  });
  const interactive = await waitPageInteractive(tabId);
  return { ...navigation, timedOut: navigation.timedOut || !interactive };
}

type Request = BrowserExecutorRequest & {
  step: Extract<BrowserExecutorRequest["step"], { op: "evaluate" | "cdp" | "waitFor" }>;
};
export async function executePageCode(
  debuggee: chrome.debugger.Debuggee,
  request: Request,
  revalidate: () => Promise<void>,
): Promise<unknown> {
  const step = request.step;
  if (step.op === "waitFor") {
    const start = Date.now();
    while (Date.now() - start < step.timeoutMs) {
      await revalidate();
      const value = await evaluatePage(
        debuggee,
        step.expression,
        Math.max(1, step.timeoutMs - (Date.now() - start)),
      );
      if (value) return { found: true, ms: Date.now() - start };
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new BrowserActionError(
      "TIMEOUT",
      "Page condition did not become true. Inspect the current state before proceeding.",
    );
  }
  const readOnly =
    step.op === "cdp" && /\.(get|describe|resolve|query|requestNode)/.test(step.method);
  if (!readOnly) await primeBrowserSettle(debuggee);
  let value: unknown;
  if (step.op === "evaluate") value = await evaluatePage(debuggee, step.expression, 8000);
  else {
    // This command operates on the claimed page session, never on a browser-wide or another target session.
    if (["Target", "Browser"].includes(step.method.split(".")[0] ?? ""))
      throw new BrowserActionError(
        "UNSUPPORTED",
        "Use browser.openTab/attachTab for target management; page.cdp addresses the selected page only.",
      );
    value = await chrome.debugger.sendCommand(debuggee, step.method, step.params);
    if (debuggee.tabId !== undefined) noteDeviceEmulation(debuggee.tabId, step.method, step.params);
  }
  return {
    value,
    ...(!readOnly ? { settle: await settleBrowserPage(debuggee, 800, Date.now(), 0) } : {}),
  };
}
async function evaluatePage(
  debuggee: chrome.debugger.Debuggee,
  expression: string,
  timeout: number,
) {
  const result = (await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    timeout,
  })) as {
    result?: { value?: unknown };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  };
  if (result.exceptionDetails)
    throw new BrowserActionError(
      "OPERATION_FAILED",
      (
        result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        "Page evaluation failed"
      ).slice(0, 1800),
    );
  return result.result?.value;
}
