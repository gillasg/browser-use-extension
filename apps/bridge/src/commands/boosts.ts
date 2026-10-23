import { readFile } from "node:fs/promises";
import { BridgeClient } from "../client.js";
import { has, type Args } from "../args.js";
import { printJson, printRows } from "../output.js";
import type { Command } from "../usage.js";

// Boosts: lasting changes to a site (styles, hidden parts, auto-clicks, network rules, scripts)
// that apply on every visit. They live in the extension, so these commands ask the browser.

const SESSION = "browserkit-cli";

async function runInBrowser(code: string): Promise<unknown> {
  const bridge = await BridgeClient.connect();
  try {
    const reply = await bridge.request("run", { code, session: SESSION });
    if (reply.error) throw new Error(String(reply.error));
    return reply.value;
  } finally {
    bridge.close();
  }
}

/** A boost from a JSON file, a JSON string, or a `@file`. */
async function boostInput(source: string): Promise<Record<string, unknown>> {
  const text = source.trimStart().startsWith("{")
    ? source
    : await readFile(source.replace(/^@/, ""), "utf8");
  const parsed = JSON.parse(text) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("A boost is a JSON object: { name, sites, css, zaps, actions, network, js }");
  return parsed as Record<string, unknown>;
}

async function list(args: Args): Promise<number> {
  const url = args.positional[0];
  const boosts = (await runInBrowser(
    `await browser.boosts.list(${url ? JSON.stringify(url) : ""})`,
  )) as Record<string, unknown>[];
  if (has(args, "json")) printJson(boosts);
  else
    printRows(
      boosts.map((boost) => [
        String(boost.id ?? ""),
        String(boost.name ?? ""),
        String(boost.enabled ?? true),
      ]),
    );
  return 0;
}

async function save(source: string | undefined): Promise<number> {
  if (!source) throw new Error("Usage: browserkit boosts save <boost.json>");
  const boost = await boostInput(source);
  printJson(await runInBrowser(`await browser.boosts.save(${JSON.stringify(boost)})`));
  return 0;
}

async function boosts(args: Args): Promise<number> {
  const [action = "list", id] = args.positional;
  if (action === "list") return list({ ...args, positional: args.positional.slice(1) });
  if (action === "save") return save(id);
  if (action === "get") {
    if (!id) throw new Error("Usage: browserkit boosts get <id>");
    printJson(await runInBrowser(`await browser.boosts.get(${JSON.stringify(id)})`));
    return 0;
  }
  if (action === "remove" || action === "enable") {
    if (!id) throw new Error(`Usage: browserkit boosts ${action} <id>`);
    const call =
      action === "remove"
        ? `await browser.boosts.remove(${JSON.stringify(id)})`
        : `await browser.boosts.enable(${JSON.stringify(id)}, ${has(args, "off") ? "false" : "true"})`;
    printJson(await runInBrowser(call));
    return 0;
  }
  throw new Error(`Unknown boosts action "${action}": list, get, save, remove or enable`);
}

export const boostsCommand: Command = {
  name: "boosts",
  group: "Change sites",
  summary: "list, save, get, remove or enable lasting changes to sites",
  help: `Usage: browserkit boosts list [url] [--json]
       browserkit boosts get <id>
       browserkit boosts save <boost.json>
       browserkit boosts remove <id>
       browserkit boosts enable <id> [--off]

A boost is a JSON object:

  { "name": "Red headings",
    "sites": [{ "type": "domain", "value": "example.com" }],
    "css": "h1 { color: red !important }",
    "zaps": [{ "selector": ".promo" }],
    "actions": [{ "do": "click", "text": "Accept all" }],
    "network": { ... },
    "js": "/* runs on every visit */" }

saving with an existing id replaces that boost. Boost scripts need "Allow User Scripts" turned
on for the extension; its css, zaps, actions and network rules apply without it.`,
  run: boosts,
};
