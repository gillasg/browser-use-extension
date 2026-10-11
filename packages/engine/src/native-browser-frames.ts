import { BrowserActionError } from "./native-browser-common.js";
import type { BrowserExecutorRequest } from "@aeon/protocol";
import { onNode } from "./native-browser-dom.js";

interface FrameNode {
  frame: { id: string; url: string; loaderId?: string; parentId?: string };
  childFrames?: FrameNode[];
}
interface FrameInfo {
  frameId: string;
  url: string;
  frameKey: string;
  sessionId?: string;
}
const sessions = new Map<number, Map<string, string>>();
chrome.debugger.onEvent.addListener((source, method, raw) => {
  if (source.tabId === undefined) return;
  const params = raw as { sessionId?: string; targetInfo?: { targetId: string; type: string } };
  if (
    method === "Target.attachedToTarget" &&
    params.sessionId &&
    params.targetInfo?.type === "iframe"
  ) {
    const map = sessions.get(source.tabId) ?? new Map<string, string>();
    map.set(params.targetInfo.targetId, params.sessionId);
    sessions.set(source.tabId, map);
    void chrome.debugger
      .sendCommand({ tabId: source.tabId, sessionId: params.sessionId }, "Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      })
      .catch(() => undefined);
  }
  if (method === "Target.detachedFromTarget")
    for (const map of sessions.values())
      for (const [id, sessionId] of map) if (sessionId === params.sessionId) map.delete(id);
});
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId !== undefined) sessions.delete(source.tabId);
});
export async function discoverFrames(debuggee: chrome.debugger.Debuggee): Promise<FrameInfo[]> {
  await chrome.debugger.sendCommand(debuggee, "Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  });
  const result: FrameInfo[] = [];
  const roots: (chrome.debugger.Debuggee & { sessionId?: string })[] = [
    debuggee,
    ...[...(sessions.get(debuggee.tabId ?? -1)?.values() ?? [])].map((sessionId) => ({
      ...debuggee,
      sessionId,
    })),
  ];
  for (const source of roots) {
    try {
      const tree = (await chrome.debugger.sendCommand(source, "Page.getFrameTree")) as {
        frameTree: FrameNode;
      };
      appendFrameTree(result, tree.frameTree, source);
    } catch (error) {
      if (!source.sessionId) throw error;
    }
  }
  return result;
}
export async function frameDebuggee(
  debuggee: chrome.debugger.Debuggee,
  frameId?: string,
  frameKey?: string,
): Promise<chrome.debugger.Debuggee> {
  if (!frameId) return debuggee;
  if (!frameKey)
    throw new BrowserActionError(
      "STALE_REF",
      "Frame document key is missing. Use a handle returned by page.frames(), or pass both frameId and frameKey from the same discovery result.",
    );
  const frame = (await discoverFrames(debuggee)).find((item) => item.frameId === frameId);
  if (!frame || !frameKey || frame.frameKey !== frameKey)
    throw new BrowserActionError(
      "STALE_REF",
      "Frame navigated or disappeared; discover frames again.",
    );
  return { ...debuggee, ...(frame.sessionId ? { sessionId: frame.sessionId } : {}) };
}
export async function frameContext(
  debuggee: chrome.debugger.Debuggee,
  frameId: string,
): Promise<number> {
  const context = (await chrome.debugger.sendCommand(debuggee, "Page.createIsolatedWorld", {
    frameId,
    worldName: "aeon-browser",
  })) as { executionContextId: number };
  return context.executionContextId;
}
export async function evaluateFrame(
  debuggee: chrome.debugger.Debuggee,
  frameId: string,
  expression: string,
): Promise<unknown> {
  const contextId = await frameContext(debuggee, frameId);
  const result = (await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
    expression,
    contextId,
    returnByValue: true,
    awaitPromise: true,
    timeout: 8000,
  })) as {
    result?: { value?: unknown };
    exceptionDetails?: { text: string; exception?: { description: string } };
  };
  if (result.exceptionDetails)
    throw new BrowserActionError(
      "OPERATION_FAILED",
      result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
    );
  return result.result?.value;
}

function appendFrameTree(
  result: FrameInfo[],
  root: FrameNode,
  source: chrome.debugger.Debuggee & { sessionId?: string },
): void {
  const pending = [root];
  while (pending.length && result.length < 64) {
    const node = pending.pop();
    if (!node) continue;
    const info = {
      frameId: node.frame.id,
      url: node.frame.url,
      frameKey: node.frame.id + ":" + (node.frame.loaderId ?? ""),
      ...(source.sessionId ? { sessionId: source.sessionId } : {}),
    };
    const prior = result.findIndex((item) => item.frameId === info.frameId);
    if (prior < 0) result.push(info);
    else if (source.sessionId) result[prior] = info;
    pending.push(...(node.childFrames ?? []));
  }
}

type Upload = BrowserExecutorRequest & {
  step: Extract<BrowserExecutorRequest["step"], { op: "upload" }>;
};
export async function uploadFiles(
  debuggee: chrome.debugger.Debuggee,
  request: Upload,
): Promise<unknown> {
  const step = request.step;
  let backendNodeId = step.backendNodeId;
  if (!backendNodeId) {
    if (!step.selector)
      throw new Error("Choose an observed file input or file chooser backendNodeId");
    const expression = `(()=>{const roots=[document],found=[];while(roots.length){const root=roots.pop();found.push(...root.querySelectorAll(${JSON.stringify(step.selector)}));for(const el of root.querySelectorAll('*'))if(el.shadowRoot)roots.push(el.shadowRoot);}if(found.length!==1)throw Error('Expected exactly one file input');return found[0];})()`;
    const result = (await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
      expression,
      ...(step.frameId ? { contextId: await frameContext(debuggee, step.frameId) } : {}),
    })) as { result?: { objectId?: string }; exceptionDetails?: unknown };
    const objectId = result.result?.objectId;
    if (!objectId || result.exceptionDetails) throw new Error("TARGET_NOT_FOUND");
    try {
      const node = (await chrome.debugger.sendCommand(debuggee, "DOM.describeNode", {
        objectId,
      })) as { node: { backendNodeId: number } };
      backendNodeId = node.node.backendNodeId;
    } finally {
      await chrome.debugger
        .sendCommand(debuggee, "Runtime.releaseObject", { objectId })
        .catch(() => undefined);
    }
  }
  const state = await onNode<{ type: string; multiple: boolean; disabled: boolean }>(
    debuggee,
    backendNodeId,
    function (this: HTMLInputElement) {
      return { type: this.type, multiple: this.multiple, disabled: this.disabled };
    },
  );
  if (state.type !== "file" || state.disabled || (!state.multiple && step.files.length > 1))
    throw new Error("INVALID_TARGET");
  await chrome.debugger.sendCommand(debuggee, "DOM.setFileInputFiles", {
    backendNodeId,
    files: step.files,
  });
  const files = await onNode<unknown>(debuggee, backendNodeId, function (this: HTMLInputElement) {
    return [...(this.files ?? [])].map((file) => ({
      name: file.name,
      size: file.size,
      type: file.type,
    }));
  });
  return { files, selected: true };
}
