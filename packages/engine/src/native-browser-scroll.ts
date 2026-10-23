import { noteActionTiming } from "./native-browser-action-timing.js";
import type { BrowserScrollState, BrowserExecutorRequest, BrowserStep } from "@browserkit/protocol";
import {
  getCenter,
  getViewportCenter,
  resolveElement,
  scrollAt,
} from "./native-browser-debugger.js";
import { browserObservationRefs } from "./native-browser-observation.js";
import { showAgentCursor } from "./native-browser-cursor.js";

export async function selectScrollContainer(
  debuggee: chrome.debugger.Debuggee,
  point: { x: number; y: number },
  horizontal: boolean,
): Promise<string> {
  const expression = `(() => {
    const horizontal = ${horizontal};
    let node = document.elementFromPoint(${point.x}, ${point.y});
    while (node && node !== document.documentElement && node !== document.body) {
      const style = getComputedStyle(node);
      const overflow = horizontal ? style.overflowX : style.overflowY;
      const extent = horizontal ? node.scrollWidth : node.scrollHeight;
      const viewport = horizontal ? node.clientWidth : node.clientHeight;
      if (/(auto|scroll|overlay)/.test(overflow) && extent > viewport + 2) return node;
      node = node.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  })()`;
  const result = (await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
    expression,
    returnByValue: false,
  })) as { result?: { objectId?: string } };
  if (!result.result?.objectId) throw new Error("UNSUPPORTED");
  return result.result.objectId;
}

export async function measureScroll(
  debuggee: chrome.debugger.Debuggee,
  objectId: string,
  horizontal: boolean,
): Promise<{ position: number; extent: number; viewport: number }> {
  const result = (await chrome.debugger.sendCommand(debuggee, "Runtime.callFunctionOn", {
    objectId,
    returnByValue: true,
    arguments: [{ value: horizontal }],
    functionDeclaration: `function(horizontal) {
      if (!this.isConnected) return null;
      return {position: horizontal ? this.scrollLeft : this.scrollTop,
        extent: horizontal ? this.scrollWidth : this.scrollHeight,
        viewport: horizontal ? this.clientWidth : this.clientHeight};
    }`,
  })) as { result?: { value?: { position: number; extent: number; viewport: number } } };
  const value = result.result?.value;
  if (!value || ![value.position, value.extent, value.viewport].every(Number.isFinite))
    throw new Error("UNSUPPORTED");
  return value;
}

type ScrollRequest = BrowserExecutorRequest & { step: Extract<BrowserStep, { op: "scroll" }> };

export async function scrollWithFeedback(
  debuggee: chrome.debugger.Debuggee,
  request: ScrollRequest,
): Promise<BrowserScrollState> {
  const step = request.step;
  const point = step.element
    ? await elementCenter(debuggee, request)
    : await getViewportCenter(debuggee);
  const horizontal = step.direction === "left" || step.direction === "right";
  const objectId = await selectScrollContainer(debuggee, point, horizontal);
  try {
    const before = await measureScroll(debuggee, objectId, horizontal);
    showAgentCursor(debuggee, point.x, point.y, false, { caption: "Scrolling " + step.direction });
    const tAct = Date.now();
    await scrollAt(debuggee, point.x, point.y, step.direction, step.amount);
    let after = before;
    for (let attempt = 0; attempt < 6; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const next = await measureScroll(debuggee, objectId, horizontal);
      const settled =
        attempt >= 2 && next.position === after.position && next.extent === after.extent;
      after = next;
      if (settled) break;
    }
    noteActionTiming(debuggee.tabId, {
      tAct,
      point,
      scroll: {
        direction: step.direction,
        amount: step.amount,
        before: before.position,
        after: after.position,
      },
    });
    const forward = step.direction === "down" || step.direction === "right";
    return {
      ...after,
      direction: step.direction,
      moved: Math.abs(after.position - before.position) > 1,
      atBoundary: forward
        ? after.position + after.viewport >= after.extent - 2
        : after.position <= 2,
    };
  } finally {
    await chrome.debugger
      .sendCommand(debuggee, "Runtime.releaseObject", { objectId })
      .catch(() => undefined);
  }
}

async function elementCenter(debuggee: chrome.debugger.Debuggee, request: ScrollRequest) {
  const ref = await resolveElement(
    debuggee,
    request.step.element,
    request.step.target,
    browserObservationRefs.refs,
    browserObservationRefs.latestSnapshots,
    request.expectedDocumentEpoch,
  );
  return getCenter(debuggee, ref.backendNodeId);
}
