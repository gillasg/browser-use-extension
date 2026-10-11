import { homedir } from "node:os";
import { join } from "node:path";

/** Where the bridge keeps its state, site skills and per-session workspaces. */
export function dataDirectory(): string {
  if (process.env.BROWSER_USE_EXTENSION_HOME) return process.env.BROWSER_USE_EXTENSION_HOME;
  if (process.platform === "win32" && process.env.LOCALAPPDATA)
    return join(process.env.LOCALAPPDATA, "browser-use-extension");
  return join(homedir(), ".browser-use-extension");
}

export const statePath = (): string => join(dataDirectory(), "bridge.json");
export const NATIVE_HOST = "com.browser_use_extension.bridge";

export interface BridgeState {
  port: number;
  token: string;
  pid: number;
}
