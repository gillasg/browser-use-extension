// When and where each action's input reached the page, for the step trace: the moment the event
// was sent, the click point and the element's box (viewport CSS pixels of the top-level page,
// measured after scrolling it into view), and scroll positions before and after.
// Screen recorders (Aperture) read these from the trace to zoom on each action; keep the shape.
export interface ActionTiming {
  tAct?: number;
  point?: { x: number; y: number };
  box?: { x: number; y: number; width: number; height: number } | undefined;
  scroll?: { direction: string; amount: number; before: number; after: number };
}

const latest = new Map<number, ActionTiming>();

export function noteActionTiming(tabId: number | undefined, timing: ActionTiming): void {
  if (tabId === undefined) return;
  latest.set(tabId, { ...latest.get(tabId), ...timing });
}

/** The timing noted for a tab since the last take, cleared. */
export function takeActionTiming(tabId: number): ActionTiming | undefined {
  const timing = latest.get(tabId);
  latest.delete(tabId);
  return timing;
}

/** An element's border box in viewport CSS pixels, or undefined when it cannot be measured. */
export async function measureBox(
  debuggee: chrome.debugger.Debuggee,
  backendNodeId: number,
): Promise<ActionTiming["box"]> {
  const result = (await chrome.debugger
    .sendCommand(debuggee, "DOM.getBoxModel", { backendNodeId })
    .catch(() => undefined)) as { model?: { border?: number[] } } | undefined;
  const quad = result?.model?.border;
  if (!quad || quad.length < 8) return undefined;
  const xs = [quad[0], quad[2], quad[4], quad[6]].map(Number),
    ys = [quad[1], quad[3], quad[5], quad[7]].map(Number);
  const x = Math.min(...xs),
    y = Math.min(...ys);
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(Math.max(...xs) - x),
    height: Math.round(Math.max(...ys) - y),
  };
}

const ratios = new Map<number, { value: number; at: number }>();
/** devicePixelRatio of a tab (screen scale times page zoom), cached for a few seconds. */
async function pixelRatio(tabId: number): Promise<number | undefined> {
  const cached = ratios.get(tabId);
  if (cached && Date.now() - cached.at < 5000) return cached.value;
  const [result] = await Promise.resolve()
    .then(() => chrome.scripting.executeScript({ target: { tabId }, func: () => devicePixelRatio }))
    .catch(() => []);
  const value = typeof result?.result === "number" ? result.result : undefined;
  if (value !== undefined) ratios.set(tabId, { value, at: Date.now() });
  return value;
}

/** Where a finished step happened, for its trace entry: the tab, whether the user could see it
 * (active in a focused window), and for input steps the timing noted while it ran. */
export async function stepTrace(tabId: number, input: boolean): Promise<Record<string, unknown>> {
  const timing = takeActionTiming(tabId);
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  const window = tab ? await chrome.windows.get(tab.windowId).catch(() => undefined) : undefined;
  return {
    tabId,
    visible: Boolean(tab?.active && window?.focused && window.state !== "minimized"),
    ...(input ? { dpr: await pixelRatio(tabId) } : {}),
    ...timing,
  };
}
