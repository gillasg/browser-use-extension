#!/usr/bin/env node
import { BridgeClient } from "./client.js";
import { startBridge } from "./bridge-server.js";
import { formatResult } from "./format.js";
import { runMcpServer } from "./mcp.js";
import { runNativeHost } from "./native-host.js";
import { nextSteps, setup } from "./setup.js";

const usage = `browser-use-extension: let agents use your real Chrome.

  setup                 register the native host and print how to connect agents
  repl "<code>"         run a browser_code cell  [--session name] [--timeout ms]
  tabs                  list the browser's open tabs
  status                show whether a browser is connected
  login                 sign in to an AI model in the browser (shared with Pi and its apps)
  logout <provider>     sign out of an AI model provider
  mcp                   run the stdio MCP server for coding agents and MCP clients
  serve                 run the bridge in the foreground`;

async function main(argv: string[]): Promise<number> {
  // Chrome launches the native host with the calling extension's origin as the first argument.
  if (argv[0]?.startsWith("chrome-extension://")) {
    await runNativeHost();
    return 0;
  }
  const [command, ...rest] = argv;
  if (command === "serve") {
    const { state } = await startBridge();
    process.stderr.write(`Bridge listening on 127.0.0.1:${state.port}\n`);
    await new Promise(() => undefined);
  }
  if (command === "mcp") {
    await runMcpServer();
    return 0;
  }
  if (command === "setup") {
    await setup({ register: !rest.includes("--no-register") });
    process.stdout.write(nextSteps() + "\n");
    return 0;
  }
  if (command === "login" || command === "logout") return modelCommand(command, rest);
  if (command === "repl" || command === "tabs" || command === "status")
    return client(command, rest);
  process.stdout.write(usage + "\n");
  return command ? 1 : 0;
}

/** Model sign-in for features that need an AI model; loaded only when asked for. */
async function modelCommand(command: string, rest: string[]): Promise<number> {
  const models = await import("pi-ai-login");
  if (command === "logout") {
    if (!rest[0]) throw new Error("Usage: browser-use-extension logout <provider>");
    await models.logout(rest[0]);
    process.stdout.write(`Signed out of ${rest[0]}.\n`);
    return 0;
  }
  const state =
    rest[0] === "status"
      ? await models.status()
      : await models.login({
          onUrl: (url) =>
            process.stdout.write(`Opening the sign-in page… If nothing opens, visit:\n${url}\n`),
        });
  const connected = state.providers.filter((provider) => provider.connected);
  process.stdout.write(
    connected.length
      ? `Connected: ${connected.map((provider) => provider.name).join(", ")}\n`
      : "No AI model connected. Run: browser-use-extension login\n",
  );
  const chosen = state.defaultModel;
  if (chosen) process.stdout.write(`Default model: ${chosen.provider}/${chosen.model}\n`);
  return 0;
}

async function client(command: string, rest: string[]): Promise<number> {
  const bridge = await BridgeClient.connect();
  try {
    if (command === "status") {
      const reply = await bridge.request("status");
      process.stdout.write(`Bridge running; ${String(reply.browsers)} browser(s) connected.\n`);
      return 0;
    }
    if (command === "tabs") {
      const reply = await bridge.request("tabs");
      for (const tab of (reply.tabs as Record<string, unknown>[] | undefined) ?? [])
        process.stdout.write(
          `${String((tab.target as { tabId?: number })?.tabId)}\t${String(tab.title ?? "")}\t${String(tab.url ?? "")}\n`,
        );
      return 0;
    }
    const code = rest.filter((_, index) => !isOption(rest, index)).join(" ");
    if (!code) throw new Error('Usage: browser-use-extension repl "<code>"');
    const result = await bridge.request("run", {
      code,
      session: option(rest, "--session") ?? "cli",
      ...(option(rest, "--timeout") ? { timeoutMs: Number(option(rest, "--timeout")) } : {}),
    });
    process.stdout.write(formatResult(result).text + "\n");
    return result.error ? 1 : 0;
  } finally {
    bridge.close();
  }
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function isOption(args: string[], index: number): boolean {
  const value = args[index] ?? "";
  return value.startsWith("--") || (index > 0 && (args[index - 1] ?? "").startsWith("--"));
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
    process.exit(1);
  },
);
