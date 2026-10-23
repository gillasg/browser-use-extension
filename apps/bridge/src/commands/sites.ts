import { has, type Args } from "../args.js";
import { out, printJson } from "../output.js";
import { addBlockedSite, readSiteRules, removeBlockedSite } from "../site-rules.js";

// Sites the agent may not use at all, kept on this machine and enforced in the browser: no tab
// can open one, browser.fetch and site API calls refuse it, and a click or redirect inside a
// working tab cannot reach it either. A site the user names in a request is allowed for that run.

const ACTIONS = new Set(["block", "unblock", "blocked"]);

export function isGuardSites(args: Args): boolean {
  return ACTIONS.has(args.positional[0] ?? "");
}

export async function guardSites(args: Args): Promise<number> {
  const [action, value] = args.positional;
  if (action === "blocked") {
    const { blocked } = await readSiteRules();
    if (has(args, "json")) printJson({ blocked });
    else if (blocked.length) for (const site of blocked) out(site);
    else out("No blocked sites.");
    return 0;
  }
  if (!value) throw new Error(`Usage: browserkit sites ${action} <site>`);
  const site = action === "block" ? await addBlockedSite(value) : await removeBlockedSite(value);
  if (!site) throw new Error(`Not a site: ${value}`);
  out(`${action === "block" ? "Blocked" : "Unblocked"} ${site}.`);
  return 0;
}
