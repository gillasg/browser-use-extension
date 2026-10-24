import type { BrowserStep } from "@browserkit/protocol";
import { browserErrorDetail, errorCode } from "./native-browser-common.js";
import { currentInventoryTabs } from "./native-inventory-client.js";

// TARGET_LOST and STALE_REF are the errors an agent sees most when a user closes or moves a tab.
// Name the tab, its URL and the step so the next attempt can use a live one.
const TAB_ERRORS = new Set(["TARGET_LOST", "STALE_REF", "TARGET_NOT_FOUND", "TARGET_BLOCKED"]);

export async function stepFailure(step: BrowserStep, error: unknown): Promise<unknown> {
  const code = errorCode(error);
  if (!TAB_ERRORS.has(code)) return error;
  const target = "target" in step ? step.target : undefined;
  const tabId = target?.tabId;
  const tab = tabId === undefined ? undefined : await chrome.tabs.get(tabId).catch(() => undefined);
  const url =
    tab?.url ??
    (target ? currentInventoryTabs().find((item) => item.target.tabId === tabId)?.url : undefined);
  const detail =
    browserErrorDetail(error) || (error instanceof Error ? error.message : String(error));
  const where = tabId === undefined ? "" : ` tab ${tabId}${url ? ` (${url})` : ""}`;
  const action = ` while the agent tried ${step.op}`;
  const fix =
    code === "STALE_REF"
      ? "; call bu.state() again for fresh ids"
      : "; the tab was closed or moved, so use browser.tabs() and attach a live one";
  const base = detail.startsWith(code) ? detail : `${code}: ${detail}`;
  return new Error(`${base}${where}${action}${fix}`);
}
