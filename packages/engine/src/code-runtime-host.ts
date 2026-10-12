import {
  BrowserCodeCancelSchema,
  BrowserCodeReplySchema,
  BrowserCodeRunSchema,
  BrowserStepSchema,
  type BrowserCodeRun,
  type BrowserStep,
  type BrowserTargetKey,
} from "@aeon/protocol";
import { browserErrorDetail, errorCode, targetIdentity } from "./native-browser-common.js";
import { executeLocalBrowserStep } from "./native-browser-executor.js";
import { browserSessionOwner } from "./native-browser-session.js";
import { currentInventoryTabs } from "./native-inventory-client.js";
import { notePreviewActivity } from "./native-browser-preview.js";
import { handOffToUser } from "./native-browser-handoff.js";
import { networkCall } from "./native-browser-network.js";
import { isLibraryRequest, libraryCall } from "./native-browser-library.js";
import { rulesCall } from "./native-browser-rules.js";
import { permissionCall } from "./native-browser-permissions.js";
import type { BrowserIdentity } from "./native-worker-identity.js";

const OFFSCREEN = "code-offscreen.html";
const MAX_STEPS = 1000;
const MAX_TRACE = 256;

interface Cell {
  run: BrowserCodeRun;
  socket: WebSocket;
  identity: BrowserIdentity;
  operationId: string;
  allowed: Map<string, BrowserTargetKey>;
  opened: Map<string, BrowserTargetKey>;
  steps: Record<string, unknown>[];
  count: number;
  calls: Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>;
  sequence: number;
  progressTimer: ReturnType<typeof setTimeout> | undefined;
  waitingForUser: boolean;
  done: boolean;
}
const cells = new Map<string, Cell>();
let offscreen: Promise<void> | undefined;

/** Handles browser.code.* frames from Core. Returns false for anything else. */
export function handleBrowserCodeMessage(
  identity: BrowserIdentity,
  socket: WebSocket,
  candidate: unknown,
): boolean {
  const run = BrowserCodeRunSchema.safeParse(candidate);
  if (run.success) {
    void startCell(identity, socket, run.data);
    return true;
  }
  const reply = BrowserCodeReplySchema.safeParse(candidate);
  if (reply.success) {
    const waiter = cells.get(reply.data.cellId)?.calls.get(reply.data.callId);
    cells.get(reply.data.cellId)?.calls.delete(reply.data.callId);
    if (reply.data.error !== undefined) waiter?.reject(new Error(reply.data.error));
    else waiter?.resolve(reply.data.value);
    return true;
  }
  const cancel = BrowserCodeCancelSchema.safeParse(candidate);
  if (cancel.success) {
    const cell = cells.get(cancel.data.cellId);
    if (cell && cancel.data.reset) void resetRealm(cell.run.chatId);
    if (cell) finish(cell, { output: "", error: "Browser workflow cancelled", reset: true });
    return true;
  }
  return false;
}

/** Drops a chat's REPL realm (session closed or runtime reset). */
export async function resetRealm(chatId: string): Promise<void> {
  if (!(await chrome.offscreen.hasDocument())) return;
  const reset = chrome.runtime
    .sendMessage({ target: "aeon-code-offscreen", kind: "reset", chatId })
    .then(
      () => true,
      () => false,
    );
  const answered = await Promise.race([
    reset,
    new Promise((done) => setTimeout(done, 1000, false)),
  ]);
  // A synchronous infinite loop blocks the realm's thread; closing the document is the only kill.
  if (!answered) await chrome.offscreen.closeDocument().catch(() => undefined);
}

async function startCell(identity: BrowserIdentity, socket: WebSocket, run: BrowserCodeRun) {
  const allowed = new Map(run.targets.map((target) => [targetIdentity(target), target]));
  const cell: Cell = {
    run,
    socket,
    identity,
    operationId: crypto.randomUUID(),
    allowed,
    opened: new Map(),
    steps: [],
    count: 0,
    calls: new Map(),
    sequence: 0,
    progressTimer: undefined,
    waitingForUser: false,
    done: false,
  };
  cells.set(run.cellId, cell);
  try {
    const result = (await toOffscreen({
      target: "aeon-code-offscreen",
      kind: "cell",
      cellId: run.cellId,
      chatId: run.chatId,
      code: run.code,
      timeoutMs: run.timeoutMs,
      attached: run.targets[0],
    })) as { value?: unknown; output?: string; error?: string; reset?: boolean } | undefined;
    finish(
      cell,
      result ?? {
        output: "",
        error: "Browser runtime did not respond; runtime reset",
        reset: true,
      },
    );
  } catch (error) {
    finish(cell, {
      output: "",
      error: String(error instanceof Error ? error.message : error),
      reset: true,
    });
  }
}

function finish(
  cell: Cell,
  result: { value?: unknown; output?: string; error?: string; reset?: boolean },
): void {
  if (cell.done) return;
  cell.done = true;
  cells.delete(cell.run.cellId);
  if (cell.progressTimer) clearTimeout(cell.progressTimer);
  for (const waiter of cell.calls.values()) waiter.reject(new Error("Browser cell finished"));
  send(cell.socket, {
    kind: "browser.code.result",
    cellId: cell.run.cellId,
    output: (result.output ?? "").slice(0, 1_000_000),
    ...(result.value !== undefined ? { value: result.value } : {}),
    ...(result.error ? { error: result.error.slice(0, 20000) } : {}),
    ...(result.reset ? { reset: true } : {}),
    steps: cell.steps.slice(-MAX_TRACE),
    opened: [...cell.opened.values()],
  });
}

// Offscreen relays calls from the sandboxed realm. Only that document may send them.
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.target !== "aeon-code-host" || message.kind !== "call") return;
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL(OFFSCREEN)) return;
  const cell = cells.get(message.cellId);
  if (!cell) {
    reply({ error: "Browser cell is no longer active" });
    return;
  }
  serve(cell, message.request).then(
    (value) => reply({ value }),
    (error: unknown) => reply({ error: describe(error) }),
  );
  return true;
});

// Non-step requests: browser info and hand-off stay local, everything else goes to Core.
function serveCall(cell: Cell, value: Record<string, unknown> | null): Promise<unknown> {
  if (value?.browserInfo === true)
    return Promise.resolve({ clientInstanceIds: [cell.identity.clientInstanceId] });
  if (value && typeof value.handoff === "object" && value.handoff)
    return handoff(cell, value.handoff);
  if (value && typeof value.network === "string")
    return networkCall(authorizedTarget(cell, value.target).tabId, value.network, value);
  if (value && typeof value.rules === "string")
    return rulesCall(authorizedTarget(cell, value.target).tabId, value);
  if (value && value.permission === "set")
    return permissionCall(authorizedTarget(cell, value.target).tabId, value);
  if (value && isLibraryRequest(value)) return libraryCall(value);
  return callCore(cell, value);
}

async function serve(cell: Cell, request: unknown): Promise<unknown> {
  const value = request as Record<string, unknown> | null;
  if (!value || typeof value.op !== "string") return serveCall(cell, value);
  const step = await prepare(cell, value);
  authorize(cell, step);
  const entry: Record<string, unknown> = {
    index: cell.steps.length,
    action: step,
    disposition: "running",
  };
  cell.steps.push(entry);
  progress(cell);
  try {
    const result = await executeLocalBrowserStep(
      cell.identity,
      cell.run.chatId,
      cell.run.toolCallId,
      cell.operationId,
      step,
    );
    if (result.kind === "tab") {
      const key = targetIdentity(result.tab.target);
      cell.allowed.set(key, result.tab.target);
      cell.opened.set(key, result.tab.target);
    }
    Object.assign(entry, { disposition: "completed", result });
    const tabId =
      result.kind === "tab"
        ? result.tab.target.tabId
        : "target" in step
          ? step.target.tabId
          : undefined;
    if (tabId !== undefined) void notePreviewActivity(cell.run.chatId, tabId);
    recordScreenshot(cell, step, result);
    return result;
  } catch (error) {
    Object.assign(entry, { disposition: "failed", code: describe(error) });
    throw error;
  } finally {
    progress(cell);
  }
}

async function handoff(cell: Cell, request: object): Promise<"done" | "cancelled"> {
  const { message } = request as { message?: unknown };
  const target = authorizedTarget(cell, (request as { target?: unknown }).target);
  void notePreviewActivity(cell.run.chatId, target.tabId);
  const text = String(message ?? "").slice(0, 500) || "Please take over, then click Done.";
  const entry: Record<string, unknown> = {
    index: cell.steps.length,
    action: { op: "handoff", message: text, target },
    disposition: "running",
  };
  cell.steps.push(entry);
  setWaiting(cell, true);
  try {
    const outcome = await handOffToUser(target.tabId, text, () => !cell.done);
    Object.assign(entry, { disposition: outcome === "done" ? "completed" : "failed" });
    return outcome;
  } catch (error) {
    Object.assign(entry, { disposition: "failed", code: describe(error) });
    throw error;
  } finally {
    setWaiting(cell, false);
  }
}

/** A target from a local request, held to the same ownership rules as browser steps. */
function authorizedTarget(cell: Cell, target: unknown): BrowserTargetKey {
  const parsed = BrowserStepSchema.safeParse({ op: "observe", kind: "semantic", target });
  if (!parsed.success || parsed.data.op !== "observe") throw new Error("INVALID_TARGET");
  authorize(cell, parsed.data);
  return parsed.data.target;
}

// Sent at once rather than throttled: Core pauses or restarts the cell deadline on it.
function setWaiting(cell: Cell, waiting: boolean): void {
  cell.waitingForUser = waiting;
  if (cell.done) return;
  send(cell.socket, {
    kind: "browser.code.progress",
    cellId: cell.run.cellId,
    steps: progressSteps(cell),
    waitingForUser: waiting,
  });
}

async function prepare(cell: Cell, value: Record<string, unknown>): Promise<BrowserStep> {
  if (++cell.count > MAX_STEPS)
    throw new Error(`Browser workflow reached its ${MAX_STEPS}-operation limit`);
  if (value.op === "openTab" && !value.clientInstanceId)
    value.clientInstanceId = cell.identity.clientInstanceId;
  if (value.op === "upload" && Array.isArray(value.files))
    value.files = await callCore(cell, { validateUpload: value.files });
  const parsed = BrowserStepSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((issue) => issue.message).join("; ");
  throw new Error("INVALID_TARGET: " + issues.slice(0, 400));
}

function authorize(cell: Cell, step: BrowserStep): void {
  if (step.op === "listTabs" || step.op === "openTab") return;
  const target = step.target;
  if (target.clientInstanceId !== cell.identity.clientInstanceId) throw new Error("TARGET_LOST");
  const key = targetIdentity(target);
  if (step.op === "attachTab") {
    // Attaching a listed tab is an explicit agent choice; Core records it after the cell.
    if (!currentInventoryTabs().some((tab) => targetIdentity(tab.target) === key))
      throw new Error("TARGET_LOST");
    cell.allowed.set(key, target);
    cell.opened.set(key, target);
    return;
  }
  if (cell.allowed.has(key) || browserSessionOwner(target.tabId) === cell.run.chatId) return;
  throw new Error("TARGET_LOST: attach the exact browser target first (browser.attachTab)");
}

function recordScreenshot(cell: Cell, step: BrowserStep, result: unknown): void {
  if (step.op !== "cdp" || step.method !== "Page.captureScreenshot") return;
  const data = (result as { data?: { value?: { data?: unknown } } }).data?.value?.data;
  if (typeof data !== "string") return;
  const format = (step.params as { format?: string } | undefined)?.format;
  cell.steps.push({
    result: {
      kind: "screenshot",
      screenshotId: crypto.randomUUID(),
      dataBase64: data,
      mimeType: format === "jpeg" ? "image/jpeg" : format === "webp" ? "image/webp" : "image/png",
    },
  });
}

function callCore(cell: Cell, request: unknown): Promise<unknown> {
  const callId = String(++cell.sequence);
  return new Promise((resolve, reject) => {
    cell.calls.set(callId, { resolve, reject });
    if (
      !send(cell.socket, { kind: "browser.code.call", cellId: cell.run.cellId, callId, request })
    ) {
      cell.calls.delete(callId);
      reject(new Error("BROWSER_OFFLINE"));
    }
  });
}

function progress(cell: Cell): void {
  if (cell.progressTimer) return;
  cell.progressTimer = setTimeout(() => {
    cell.progressTimer = undefined;
    if (cell.done) return;
    send(cell.socket, {
      kind: "browser.code.progress",
      cellId: cell.run.cellId,
      steps: progressSteps(cell),
    });
  }, 150);
}

// Progress is for the live activity view; images and full observations wait for the result.
function progressSteps(cell: Cell): Record<string, unknown>[] {
  return cell.steps.slice(-MAX_TRACE).map(({ result, ...rest }) => ({
    ...rest,
    ...(result ? { result: { kind: (result as { kind?: unknown }).kind } } : {}),
  }));
}

async function ensureOffscreen(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) return;
  offscreen ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN,
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification: "Runs browser_code cells in a persistent sandboxed JavaScript realm.",
    })
    .catch((error: unknown) => {
      if (!String(error).includes("Only a single offscreen")) throw error;
    })
    .finally(() => {
      offscreen = undefined;
    });
  await offscreen;
}

async function toOffscreen(message: Record<string, unknown>): Promise<unknown> {
  await ensureOffscreen();
  return chrome.runtime.sendMessage(message);
}

function send(socket: WebSocket, message: unknown): boolean {
  if (socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}

function describe(error: unknown): string {
  const code = errorCode(error);
  const detail = browserErrorDetail(error);
  const message = error instanceof Error ? error.message : String(error);
  if (code === "OPERATION_FAILED" && message && message !== code) return message;
  return detail ? `${code}: ${detail}` : code;
}
