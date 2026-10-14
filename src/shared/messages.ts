// Messages between the pages, the content script and the service worker.

export interface Reply<T = unknown> {
  ok: boolean;
  value?: T;
  error?: string;
}

/** Sends a request to the service worker and unwraps the reply. */
export async function send<T = unknown>(
  kind: string,
  data: Record<string, unknown> = {},
): Promise<T> {
  const reply = (await chrome.runtime.sendMessage({ kind, ...data })) as Reply<T> | undefined;
  if (!reply) throw new Error("No answer from the extension");
  if (!reply.ok) throw new Error(reply.error ?? "Failed");
  return reply.value as T;
}

/** Sends a request to the content script of a tab (the top frame unless one is named). */
export async function sendToTab<T = unknown>(
  tabId: number,
  kind: string,
  data: Record<string, unknown> = {},
  frameId = 0,
): Promise<T> {
  const reply = (await chrome.tabs.sendMessage(tabId, { kind, ...data }, { frameId })) as
    Reply<T> | undefined;
  if (!reply) throw new Error("The page did not answer. Reload it and try again.");
  if (!reply.ok) throw new Error(reply.error ?? "Failed");
  return reply.value as T;
}

export const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
