import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Validators } from "./fetch/types.js";
import type { PageResult } from "./types.js";

// Freshness and change tracking: a cached copy per URL with its validators (ETag,
// Last-Modified) and content hash. Pages are served from cache under maxAge, re-fetched with
// conditional requests otherwise, and compared with the last copy (new, same or changed, with a diff).

interface Entry {
  url: string;
  fetchedAt: string;
  etag?: string;
  lastModified?: string;
  contentHash?: string;
  result: PageResult;
}

const key = (url: string) => createHash("sha256").update(url).digest("hex").slice(0, 40);

export class PageCache {
  constructor(private readonly dir: string) {}

  private path(url: string): string {
    return join(this.dir, key(url).slice(0, 2), `${key(url)}.json`);
  }

  async get(url: string): Promise<Entry | undefined> {
    try {
      return JSON.parse(await readFile(this.path(url), "utf8")) as Entry;
    } catch {
      return undefined;
    }
  }

  async put(url: string, result: PageResult, headers: Record<string, string> = {}): Promise<void> {
    const entry: Entry = { url, fetchedAt: result.fetchedAt, result };
    if (headers.etag) entry.etag = headers.etag;
    if (headers["last-modified"]) entry.lastModified = headers["last-modified"];
    if (result.contentHash) entry.contentHash = result.contentHash;
    const path = this.path(url);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, JSON.stringify(entry));
  }
}

export function isFresh(
  entry: { fetchedAt: string } | undefined,
  maxAge: number | undefined,
): boolean {
  return !!entry && maxAge !== undefined && Date.now() - Date.parse(entry.fetchedAt) < maxAge;
}

export function validators(entry: Entry | undefined): Validators | undefined {
  if (!entry) return undefined;
  const out: Validators = {};
  if (entry.etag) out.etag = entry.etag;
  if (entry.lastModified) out.lastModified = entry.lastModified;
  return out.etag || out.lastModified ? out : undefined;
}

/** Longest-common-subsequence lengths, as a lookup: at(i, j) for a[i..] against b[j..]. */
function lcsTable(a: string[], b: string[]): (i: number, j: number) => number {
  const width = b.length + 1;
  const table = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      table[i * width + j] =
        a[i] === b[j]
          ? (table[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
  return (i, j) => table[i * width + j] ?? 0;
}

/** A small line diff: removed lines with `-`, added with `+` (longest common subsequence). */
export function lineDiff(before: string, after: string, max = 400): string {
  const a = before.split("\n").slice(0, 2000);
  const b = after.split("\n").slice(0, 2000);
  const at = lcsTable(a, b);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while ((i < a.length || j < b.length) && out.length < max) {
    if (a[i] !== undefined && a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    const remove = i < a.length && (j >= b.length || at(i + 1, j) >= at(i, j + 1));
    out.push(remove ? `- ${a[i++]}` : `+ ${b[j++]}`);
  }
  return out.join("\n");
}
/** Compares a new result with the cached one. */
export function changeOf(previous: Entry | undefined, result: PageResult): PageResult["change"] {
  if (!previous) return { status: "new" };
  if (previous.contentHash && previous.contentHash === result.contentHash)
    return { status: "same" };
  const before = previous.result.markdown ?? "";
  const after = result.markdown ?? "";
  return before || after
    ? { status: "changed", diff: lineDiff(before, after) }
    : { status: "changed" };
}
