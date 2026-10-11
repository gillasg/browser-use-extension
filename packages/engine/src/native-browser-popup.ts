import { BrowserPopupSchema, type BrowserTab } from "@aeon/protocol";
import { currentInventoryTabs, refreshInventoryTab } from "./native-inventory-client.js";
import {
  browserSessionOwner,
  bindBrowserSession,
  restoreBrowserSessionOwners,
} from "./native-browser-session.js";
import { publishBrowserEvent } from "./native-browser-events.js";
const children = new Map<number, Set<number>>();
const active = new Map<number, number>(),
  previous = new Map<number, number>();
const handled = new Set<number>();
let socket: WebSocket | undefined;
export function installBrowserPopupGuard(connection: WebSocket): void {
  socket = connection;
  void restoreBrowserSessionOwners();
  void chrome.tabs.query({ active: true }).then((tabs) => {
    for (const tab of tabs) if (tab.id !== undefined) active.set(tab.windowId, tab.id);
  });
}
export async function browserPopups(tabId: number): Promise<BrowserTab[]> {
  const tabs = await Promise.all(
    [...(children.get(tabId) ?? [])].map((id) => refreshInventoryTab(id)),
  );
  return tabs.filter((tab): tab is BrowserTab => Boolean(tab));
}
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  const old = active.get(windowId);
  if (old !== undefined && old !== tabId) previous.set(windowId, old);
  active.set(windowId, tabId);
});
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id !== undefined && tab.openerTabId !== undefined) void adopt(tab.id, tab.openerTabId);
});
chrome.webNavigation.onCreatedNavigationTarget.addListener(
  (event) => void adopt(event.tabId, event.sourceTabId),
);
chrome.tabs.onRemoved.addListener((tabId) => {
  children.delete(tabId);
  handled.delete(tabId);
  for (const set of children.values()) set.delete(tabId);
});
async function adopt(tabId: number, openerId: number): Promise<void> {
  try {
    const owner = browserSessionOwner(openerId);
    const connection = socket;
    if (!owner || handled.has(tabId) || !connection || connection.readyState !== WebSocket.OPEN)
      return;
    handled.add(tabId);
    const tab = await chrome.tabs.get(tabId);
    await restoreForeground(tab, tabId, openerId);
    const set = children.get(openerId) ?? new Set<number>();
    set.add(tabId);
    children.set(openerId, set);
    bindBrowserSession(tabId, owner);
    publishBrowserEvent(openerId, "popup", { tabId, openerId });
    await publishPopup(tabId, openerId, owner, connection);
  } catch {
    /* A popup can disappear before adoption finishes. */
  }
}
async function publishPopup(
  tabId: number,
  openerId: number,
  chatId: string,
  connection: WebSocket,
): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (connection.readyState !== WebSocket.OPEN) return;
    const tab = await refreshInventoryTab(tabId);
    const opener = currentInventoryTabs().find((item) => item.target.tabId === openerId);
    if (tab && opener && /^https?:/.test(tab.url)) {
      connection.send(
        JSON.stringify(
          BrowserPopupSchema.parse({ kind: "browser.popup", chatId, opener: opener.target, tab }),
        ),
      );
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function restoreForeground(
  tab: chrome.tabs.Tab,
  tabId: number,
  openerId: number,
): Promise<void> {
  const foreground = active.get(tab.windowId);
  const userTab = foreground === tabId ? previous.get(tab.windowId) : foreground;
  if (tab.active && userTab !== undefined && userTab !== openerId) {
    // Do not override a subsequent deliberate user switch.
    const current = await chrome.tabs.query({ windowId: tab.windowId, active: true });
    if (current[0]?.id === tabId) await chrome.tabs.update(userTab, { active: true });
  }
}
