import {
  addBlockedSite,
  readBlockedSites,
  removeBlockedSite,
  siteName,
} from "@browserkit/tools/host";

// Sites agents must never touch (a bank, a mail inbox), kept on this machine in
// browserkit's site-rules.json. The extension asks for the list at the start of every cell and
// blocks every route to them while the cell runs: steps, browser.fetch, site API calls, and the
// tab's own requests through a network rule. Only the user changes the list.

export { addBlockedSite, removeBlockedSite, siteName };

export async function readSiteRules(): Promise<{ blocked: string[] }> {
  return { blocked: await readBlockedSites() };
}
