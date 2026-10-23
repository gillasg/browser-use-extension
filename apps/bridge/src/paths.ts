import { homedir } from "node:os";
import { join } from "node:path";

/** Where the bridge keeps its state, site skills and per-session workspaces. */
export function dataDirectory(): string {
  const home = process.env.BROWSERKIT_HOME ?? process.env.BROWSER_USE_EXTENSION_HOME;
  if (home) return home;
  if (process.platform === "win32" && process.env.LOCALAPPDATA)
    return join(process.env.LOCALAPPDATA, "browserkit");
  if (process.platform === "darwin")
    return join(homedir(), "Library", "Application Support", "browserkit");
  const xdg = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(xdg, "browserkit");
}

export const statePath = (): string => join(dataDirectory(), "bridge.json");
export const NATIVE_HOST = "com.browserkit.bridge";

export interface BridgeState {
  port: number;
  token: string;
  pid: number;
}
