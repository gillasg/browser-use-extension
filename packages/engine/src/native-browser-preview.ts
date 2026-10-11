import { withBrowserDebugger } from "./native-browser-session.js";

// Aside-style live preview: while a chat works in a tab the user cannot see, its chat page
// shows a small, slow-refreshing thumbnail. Visible tabs (active or in Split View) get none.
const FRAME_MS = 1000;
const LINGER_MS = 4000;
type SplitTab = chrome.tabs.Tab & { splitViewId?: number };
interface Preview {
  tabId: number;
  lastActivity: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}
const previews = new Map<string, Preview>();

export function notePreviewActivity(chatId: string, tabId: number): void {
  const current = previews.get(chatId);
  if (current && current.tabId === tabId) {
    current.lastActivity = Date.now();
    return;
  }
  if (current) stop(chatId, current);
  const preview: Preview = { tabId, lastActivity: Date.now(), timer: undefined };
  previews.set(chatId, preview);
  schedule(chatId, preview, 150);
}

function schedule(chatId: string, preview: Preview, delay: number): void {
  preview.timer = setTimeout(() => void frame(chatId, preview), delay);
}

async function frame(chatId: string, preview: Preview): Promise<void> {
  if (previews.get(chatId) !== preview) return;
  if (Date.now() - preview.lastActivity > LINGER_MS) return stop(chatId, preview);
  const tab = (await chrome.tabs.get(preview.tabId).catch(() => undefined)) as SplitTab | undefined;
  if (!tab) return stop(chatId, preview);
  if (tab.active || (tab.splitViewId ?? -1) >= 0) {
    publish(chatId, preview.tabId, tab, null);
    return schedule(chatId, preview, FRAME_MS);
  }
  const image = await withBrowserDebugger(preview.tabId, (debuggee) =>
    chrome.debugger.sendCommand(debuggee, "Page.captureScreenshot", {
      format: "jpeg",
      quality: 40,
      optimizeForSpeed: true,
    }),
  ).then(
    (result) => "data:image/jpeg;base64," + (result as { data: string }).data,
    () => null,
  );
  if (previews.get(chatId) !== preview) return;
  publish(chatId, preview.tabId, tab, image);
  schedule(chatId, preview, FRAME_MS);
}

function stop(chatId: string, preview: Preview): void {
  if (preview.timer) clearTimeout(preview.timer);
  if (previews.get(chatId) === preview) previews.delete(chatId);
  publish(chatId, preview.tabId, undefined, null);
}

function publish(
  chatId: string,
  tabId: number,
  tab: chrome.tabs.Tab | undefined,
  image: string | null,
) {
  void chrome.runtime
    .sendMessage({
      kind: "aeon.browser.preview",
      chatId,
      tabId,
      title: tab?.title ?? "",
      url: tab?.url ?? "",
      image,
    })
    .catch(() => undefined);
}
