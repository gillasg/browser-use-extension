import { migrateLegacyChromeStorage } from "./legacy-storage-migration.js";

const INSTANCE_KEY = "aeon-client-instance-id";
const RUN_KEY = "aeon-browser-run-id";

export interface BrowserIdentity {
  clientInstanceId: string;
  browserRunId: string;
}

export async function getBrowserIdentity(): Promise<BrowserIdentity> {
  await migrateLegacyChromeStorage();
  const local = await chrome.storage.local.get(INSTANCE_KEY);
  const instance = isUuid(local[INSTANCE_KEY]) ? local[INSTANCE_KEY] : crypto.randomUUID();
  if (local[INSTANCE_KEY] !== instance)
    await chrome.storage.local.set({ [INSTANCE_KEY]: instance });
  const session = await chrome.storage.session.get(RUN_KEY);
  const run = isUuid(session[RUN_KEY]) ? session[RUN_KEY] : crypto.randomUUID();
  if (session[RUN_KEY] !== run) await chrome.storage.session.set({ [RUN_KEY]: run });
  return { clientInstanceId: instance, browserRunId: run };
}

export function sameScope(
  left: import("@browserkit/protocol").PageGrantScope,
  right: import("@browserkit/protocol").PageGrantScope,
): boolean {
  return (
    left.kind === right.kind &&
    (left.kind !== "chat" || (right.kind === "chat" && left.chatId === right.chatId))
  );
}

export function hostErrorCode(message: string): string {
  const normalized = message.toLowerCase();
  return normalized.includes("native messaging host not found") ||
    normalized.includes("access to the specified native messaging host is forbidden")
    ? "HOST_MISSING"
    : "DAEMON_OFFLINE";
}

export function nativeErrorCode(error: unknown): string {
  const code = error instanceof Error ? error.message : "BOOTSTRAP_UNAVAILABLE";
  return [
    "HOST_MISSING",
    "HOST_CONFIG_INVALID",
    "DAEMON_OFFLINE",
    "CONNECTION_TIMEOUT",
    "UPDATE_REQUIRED",
    "BOOTSTRAP_UNAVAILABLE",
  ].includes(code)
    ? code
    : "BOOTSTRAP_UNAVAILABLE";
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}
