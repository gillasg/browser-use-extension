import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { dataDirectory } from "./paths.js";

// Sites agents must never touch (a bank, a mail inbox), kept on this machine. The extension asks
// for the list at the start of every cell and blocks every route to them while the cell runs:
// steps, browser.fetch, site API calls, and the tab's own requests through a network rule.

const path = (): string => join(dataDirectory(), "site-rules.json");

export function isSiteRulesRequest(value: unknown): boolean {
  return (value as { siteRules?: unknown } | null)?.siteRules === true;
}

export async function readSiteRules(): Promise<{ blocked: string[] }> {
  try {
    const value = JSON.parse(await readFile(path(), "utf8")) as { blocked?: unknown };
    return { blocked: Array.isArray(value.blocked) ? value.blocked.map(String) : [] };
  } catch {
    return { blocked: [] };
  }
}

async function save(blocked: string[]): Promise<void> {
  await mkdir(dirname(path()), { recursive: true });
  await writeFile(path(), JSON.stringify({ blocked }, null, 2) + "\n");
}

/** The site part of a URL or a bare domain, without www. */
export function siteName(value: string): string | undefined {
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(value) ? value : "https://" + value);
    return url.hostname.toLowerCase().replace(/^www\./, "") || undefined;
  } catch {
    return undefined;
  }
}

export async function addBlockedSite(value: string): Promise<string | undefined> {
  const site = siteName(value);
  if (!site) return undefined;
  const { blocked } = await readSiteRules();
  await save([...new Set([...blocked, site])]);
  return site;
}

export async function removeBlockedSite(value: string): Promise<string | undefined> {
  const site = siteName(value);
  if (!site) return undefined;
  const { blocked } = await readSiteRules();
  await save(blocked.filter((item) => item !== site));
  return site;
}
