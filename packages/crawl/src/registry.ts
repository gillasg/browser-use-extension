import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionFile } from "./session.js";

// Reading the site-to-api registry on disk: the site name for a URL and the session it exported
// (`~/.site-to-api/sites/<site>/session.json`). Nothing here writes to it.
//
// Copied from site-to-api (`src/registry.ts`) so browser-crawl can stand alone.

export function registryRoot(): string {
  return process.env.SITE_TO_API_HOME ?? join(homedir(), ".site-to-api");
}

/** `https://www.shop.example/x` -> `shop.example`. */
export function siteName(input: string): string {
  const trimmed = input.trim();
  const host = /^[a-z]+:\/\//i.test(trimmed)
    ? new URL(trimmed).host
    : (trimmed.split("/")[0] ?? trimmed);
  return host.toLowerCase().replace(/^www\./, "");
}

function siteDir(site: string): string {
  return join(registryRoot(), "sites", siteName(site).replace(/:/g, "_"));
}

export async function readSession(site: string): Promise<SessionFile | undefined> {
  try {
    return JSON.parse(await readFile(join(siteDir(site), "session.json"), "utf8")) as SessionFile;
  } catch {
    return undefined;
  }
}
