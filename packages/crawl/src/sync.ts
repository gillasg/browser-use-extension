import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Crawl, type CrawlDeps } from "./crawler.js";
import type { CrawlEvent, CrawlOptions, PageResult } from "./types.js";

// Sync: a local Markdown mirror of a site (a wiki, a docs portal, a vendor area behind a login)
// kept up to date. Each run re-checks pages with conditional requests, rewrites only what
// changed, and removes pages that are gone.

interface Manifest {
  url: string;
  syncedAt: string;
  pages: Record<string, { file: string; hash?: string; title?: string; fetchedAt: string }>;
}

export interface SyncReport {
  added: string[];
  changed: string[];
  unchanged: string[];
  removed: string[];
  failed: string[];
}

function fileFor(url: string): string {
  const parsed = new URL(url);
  let path = decodeURIComponent(parsed.pathname).replace(/[<>:"|?*\\]/g, "_");
  if (path.endsWith("/")) path += "index";
  path = path.replace(/\.(html?|php|aspx?)$/i, "");
  const query = parsed.search
    ? "__" + Buffer.from(parsed.search).toString("base64url").slice(0, 16)
    : "";
  return join(parsed.host.replace(/:/g, "_"), `${path}${query}.md`);
}

async function readManifest(dir: string): Promise<Manifest | undefined> {
  try {
    return JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as Manifest;
  } catch {
    return undefined;
  }
}

function frontMatter(result: PageResult): string {
  const lines = [
    `url: ${result.finalUrl}`,
    `title: ${JSON.stringify(result.title ?? "")}`,
    `fetched: ${result.fetchedAt}`,
  ];
  return `---\n${lines.join("\n")}\n---\n\n`;
}

/** Records a page in the manifest and report; returns the file to write when it is new or changed. */
function mirrorPage(
  page: PageResult,
  previous: Manifest | undefined,
  manifest: Manifest,
  report: SyncReport,
): string | undefined {
  const file = fileFor(page.url);
  const before = previous?.pages[page.url];
  manifest.pages[page.url] = {
    file,
    ...(page.contentHash ? { hash: page.contentHash } : {}),
    ...(page.title ? { title: page.title } : {}),
    fetchedAt: page.fetchedAt,
  };
  if (before && before.hash === page.contentHash) {
    report.unchanged.push(page.url);
    return undefined;
  }
  (before ? report.changed : report.added).push(page.url);
  return file;
}

async function writePage(dir: string, file: string, page: PageResult): Promise<void> {
  await mkdir(dirname(join(dir, file)), { recursive: true });
  await writeFile(join(dir, file), frontMatter(page) + (page.markdown ?? ""));
}

export async function syncSite(
  options: CrawlOptions & { dir: string },
  deps: CrawlDeps = {},
): Promise<SyncReport> {
  const previous = await readManifest(options.dir);
  const manifest: Manifest = {
    url: options.url ?? "",
    syncedAt: new Date().toISOString(),
    pages: {},
  };
  const report: SyncReport = { added: [], changed: [], unchanged: [], removed: [], failed: [] };
  const job = new Crawl({ ...options, formats: ["markdown", "metadata", "links"] }, deps);
  const writes: Promise<void>[] = [];
  job.on("page", (event: CrawlEvent) => {
    const page = event.page;
    if (!page || page.status === 0 || page.status >= 400 || page.error) {
      if (page && page.status !== 0) report.failed.push(page.url);
      return;
    }
    const write = mirrorPage(page, previous, manifest, report);
    if (write) writes.push(writePage(options.dir, write, page));
  });
  await job.start();
  await Promise.all(writes);
  const complete = job.state === "completed" && job.stats.completed < (options.limit ?? 100);
  for (const [url, page] of Object.entries(previous?.pages ?? {})) {
    if (manifest.pages[url]) continue;
    if (!complete) {
      manifest.pages[url] = page;
      continue;
    }
    report.removed.push(url);
    await rm(join(options.dir, page.file), { force: true });
  }
  await mkdir(options.dir, { recursive: true });
  await writeFile(join(options.dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return report;
}
