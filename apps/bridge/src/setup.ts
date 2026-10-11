import { execFileSync } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_HOST, dataDirectory } from "./paths.js";

// Registers the native messaging host that lets the extension find the bridge, then prints how
// to load the extension and connect agents.
export const EXTENSION_ID = "dmlgohfphkbenjopdphcojgjeidlmajj";
const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
const extensionBuild = fileURLToPath(new URL("../../extension/build", import.meta.url));

const browsers: Record<string, { win: string; mac: string; linux: string }> = {
  chrome: {
    win: "Software\\Google\\Chrome\\NativeMessagingHosts",
    mac: "Library/Application Support/Google/Chrome/NativeMessagingHosts",
    linux: ".config/google-chrome/NativeMessagingHosts",
  },
  edge: {
    win: "Software\\Microsoft\\Edge\\NativeMessagingHosts",
    mac: "Library/Application Support/Microsoft Edge/NativeMessagingHosts",
    linux: ".config/microsoft-edge/NativeMessagingHosts",
  },
  brave: {
    win: "Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts",
    mac: "Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts",
    linux: ".config/BraveSoftware/Brave-Browser/NativeMessagingHosts",
  },
};

export async function setup(options: { register: boolean }): Promise<string> {
  const folder = join(dataDirectory(), "native-host");
  await mkdir(folder, { recursive: true });
  const launcher = await writeLauncher(folder);
  const manifest = join(folder, NATIVE_HOST + ".json");
  await writeFile(
    manifest,
    JSON.stringify(
      {
        name: NATIVE_HOST,
        description: "Browser Use Extension bridge",
        path: launcher,
        type: "stdio",
        allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
      },
      null,
      2,
    ),
  );
  if (options.register) await register(manifest);
  return manifest;
}

async function writeLauncher(folder: string): Promise<string> {
  if (process.platform === "win32") {
    const path = join(folder, "host.cmd");
    await writeFile(path, `@echo off\r\n"${process.execPath}" "${cli}" %*\r\n`);
    return path;
  }
  const path = join(folder, "host.sh");
  await writeFile(path, `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`);
  await chmod(path, 0o755);
  return path;
}

async function register(manifest: string): Promise<void> {
  for (const browser of Object.values(browsers)) {
    if (process.platform === "win32") {
      execFileSync(
        "reg.exe",
        ["add", `HKCU\\${browser.win}\\${NATIVE_HOST}`, "/ve", "/t", "REG_SZ", "/d", manifest, "/f"],
        { stdio: "ignore", windowsHide: true },
      );
      continue;
    }
    const directory = join(homedir(), process.platform === "darwin" ? browser.mac : browser.linux);
    await mkdir(directory, { recursive: true });
    const { copyFile } = await import("node:fs/promises");
    await copyFile(manifest, join(directory, NATIVE_HOST + ".json"));
  }
}

export function nextSteps(): string {
  const command = `"${process.execPath}" "${cli}" mcp`;
  return [
    "Native host registered for Chrome, Edge and Brave.",
    "",
    "1. Load the extension: open chrome://extensions, turn on Developer mode, click",
    `   "Load unpacked" and choose: ${extensionBuild}`,
    "2. Connect an agent:",
    `   Claude Code:  claude mcp add browser-use-extension -- ${command}`,
    `   Codex:        add to ~/.codex/config.toml:`,
    `                 [mcp_servers.browser-use-extension]`,
    `                 command = ${JSON.stringify(process.execPath)}`,
    `                 args = [${JSON.stringify(cli)}, "mcp"]`,
    `   Any MCP client: {"command": ${JSON.stringify(process.execPath)}, "args": [${JSON.stringify(cli)}, "mcp"]}`,
    "3. Try it: browser-use-extension repl \"(await browser.tabs()).length\"",
  ].join("\n");
}
