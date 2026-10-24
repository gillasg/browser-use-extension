import { has, type Args } from "../args.js";
import { out, printJson } from "../output.js";
import { addBlockedSite, readSiteRules, removeBlockedSite } from "../site-rules.js";
import type { Command } from "../usage.js";

// Sites the agent may not use at all, kept on this machine and enforced in the browser: no tab
// can open one, browser.fetch and site API calls refuse it, and a click or redirect inside a
// working tab cannot reach it either. Only the user changes the list.
// This is separate from `browserkit sites`, which lists mapped sites.

function requiredSite(args: Args, usage: string): string {
  const value = args.positional[0];
  if (!value) throw new Error(usage);
  return value;
}

async function block(args: Args): Promise<number> {
  const value = requiredSite(args, "Usage: browserkit block <site>");
  const site = await addBlockedSite(value);
  if (!site) throw new Error(`Not a site: ${value}`);
  out(`Blocked ${site}. Agents will not open it, fetch it or call its API.`);
  return 0;
}

async function unblock(args: Args): Promise<number> {
  const value = requiredSite(args, "Usage: browserkit unblock <site>");
  const site = await removeBlockedSite(value);
  if (!site) throw new Error(`Not a site: ${value}`);
  out(`Unblocked ${site}.`);
  return 0;
}

async function blocked(args: Args): Promise<number> {
  const { blocked: sites } = await readSiteRules();
  if (has(args, "json")) printJson({ blocked: sites });
  else if (sites.length) for (const site of sites) out(site);
  else out("No blocked sites.");
  return 0;
}

export const blockCommand: Command = {
  name: "block",
  group: "Blocked sites",
  summary: "stop every agent from using a site, for good",
  help: `Usage: browserkit block <site>

Puts the site (and its subdomains) off limits for every agent: no tab opens it, browser.fetch
and site API calls refuse it, and requests a working tab makes to it (clicks, redirects,
scripts) are blocked. Only the user changes the list, with \`browserkit unblock\`.
The list lives in site-rules.json in browserkit's data folder; the extension's own block list
adds to it. \`browserkit sites\` lists mapped sites, which is a different thing.`,
  run: block,
};

export const unblockCommand: Command = {
  name: "unblock",
  group: "Blocked sites",
  summary: "let agents use a site again",
  help: `Usage: browserkit unblock <site>

Removes the site from the list \`browserkit blocked\` shows.`,
  run: unblock,
};

export const blockedCommand: Command = {
  name: "blocked",
  group: "Blocked sites",
  summary: "list the sites agents may not use",
  help: `Usage: browserkit blocked [--json]

  --json   {"blocked": [...]} instead of one site per line`,
  run: blocked,
};

export const blockGroup = [blockCommand, unblockCommand, blockedCommand];
