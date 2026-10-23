import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CrawlOptions, CrawlStats, JobState, PageResult, PageStatus } from "./types.js";

// Where jobs live: ~/.browser-crawl/jobs/<id>/ (or the crawl's stateDir) with the job record,
// results as JSON lines, per-URL states and the frontier, so a crawl can be paused, resumed after
// a restart, and read page by page with a cursor.

export function crawlHome(): string {
  return process.env.BROWSER_CRAWL_HOME ?? join(homedir(), ".browser-crawl");
}

export interface JobRecord {
  id: string;
  state: JobState;
  options: CrawlOptions;
  stats: CrawlStats;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export class JobStore {
  readonly dir: string;
  private count = 0;

  constructor(
    readonly id: string,
    dir?: string,
  ) {
    this.dir = dir ?? join(crawlHome(), "jobs", id);
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    this.count = (await this.readLines()).length;
  }

  private async readLines(): Promise<string[]> {
    try {
      return (await readFile(join(this.dir, "results.jsonl"), "utf8")).split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }

  async append(result: PageResult): Promise<void> {
    await appendFile(join(this.dir, "results.jsonl"), JSON.stringify(result) + "\n");
    this.count++;
  }

  get resultCount(): number {
    return this.count;
  }

  /** Results from `cursor` on; `next` is the cursor for the following page, if any. */
  async results(
    cursor = 0,
    limit = 50,
  ): Promise<{ results: PageResult[]; next?: number; total: number }> {
    const lines = await this.readLines();
    const slice = lines.slice(cursor, cursor + limit).map((line) => JSON.parse(line) as PageResult);
    const next = cursor + slice.length;
    return { results: slice, total: lines.length, ...(next < lines.length ? { next } : {}) };
  }

  async saveRecord(record: JobRecord): Promise<void> {
    await writeFile(join(this.dir, "job.json"), JSON.stringify(record, null, 2));
  }

  async readRecord(): Promise<JobRecord | undefined> {
    return readJson<JobRecord>(join(this.dir, "job.json"));
  }

  async saveState(state: { frontier: unknown; urls: Record<string, PageStatus> }): Promise<void> {
    await writeFile(join(this.dir, "state.json"), JSON.stringify(state));
  }

  async readState(): Promise<
    { frontier: { items: never[]; seen: string[] }; urls: Record<string, PageStatus> } | undefined
  > {
    return readJson(join(this.dir, "state.json"));
  }
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export async function listJobs(): Promise<JobRecord[]> {
  const root = join(crawlHome(), "jobs");
  const ids = await readdir(root).catch(() => [] as string[]);
  const records = await Promise.all(ids.map((id) => new JobStore(id).readRecord()));
  return records
    .filter((record): record is JobRecord => !!record)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Deletes finished jobs older than `days`. */
export async function pruneJobs(days = 7): Promise<number> {
  const root = join(crawlHome(), "jobs");
  let removed = 0;
  for (const id of await readdir(root).catch(() => [] as string[])) {
    const record = await new JobStore(id).readRecord();
    const info = await stat(join(root, id)).catch(() => undefined);
    const updated = record ? Date.parse(record.updatedAt) : (info?.mtimeMs ?? Date.now());
    if (record?.state === "running" || record?.state === "paused") continue;
    if (Date.now() - updated > days * 86_400_000) {
      await rm(join(root, id), { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}
