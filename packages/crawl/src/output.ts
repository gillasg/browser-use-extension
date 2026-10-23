import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { PageResult } from "./types.js";

// Exports: JSON lines, CSV, or a dataset folder (one Markdown and one JSON file per page, plus an index).

const CSV_COLUMNS = [
  "url",
  "finalUrl",
  "status",
  "depth",
  "fetchedBy",
  "title",
  "score",
  "change",
  "markdown",
  "error",
] as const;

function csvCell(value: unknown): string {
  const text =
    value === undefined || value === null
      ? ""
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(results: PageResult[]): string {
  const rows = results.map((result) =>
    CSV_COLUMNS.map((column) =>
      csvCell(
        column === "change"
          ? result.change?.status
          : (result as unknown as Record<string, unknown>)[column],
      ),
    ).join(","),
  );
  return [CSV_COLUMNS.join(","), ...rows].join("\n") + "\n";
}

export function toJsonl(results: PageResult[]): string {
  return results.map((result) => JSON.stringify(result)).join("\n") + (results.length ? "\n" : "");
}

/** A file name for a URL: its path, made safe, unique within the folder. */
export function slug(url: string, used: Set<string>): string {
  const parsed = new URL(url);
  const base =
    `${parsed.host}${parsed.pathname}`
      .replace(/\/$/, "/index")
      .replace(/[^\w.-]+/g, "_")
      .replace(/_+/g, "_")
      .slice(0, 150) +
    (parsed.search ? "_" + Buffer.from(parsed.search).toString("base64url").slice(0, 12) : "");
  let name = base;
  for (let n = 2; used.has(name); n++) name = `${base}_${n}`;
  used.add(name);
  return name;
}

export async function writeDataset(results: PageResult[], dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const used = new Set<string>();
  const index: { url: string; title?: string; file: string; status: number }[] = [];
  for (const result of results) {
    const name = slug(result.url, used);
    if (result.markdown) await writeFile(join(dir, `${name}.md`), result.markdown);
    await writeFile(join(dir, `${name}.json`), JSON.stringify(result, null, 2));
    index.push({
      url: result.url,
      ...(result.title ? { title: result.title } : {}),
      file: name,
      status: result.status,
    });
  }
  await writeFile(join(dir, "index.json"), JSON.stringify(index, null, 2));
}

/** Writes results by file type: .jsonl, .csv, .json, or a folder. */
export async function writeOutput(results: PageResult[], target: string): Promise<void> {
  const extension = extname(target).toLowerCase();
  if (extension === ".jsonl") await writeFile(target, toJsonl(results));
  else if (extension === ".csv") await writeFile(target, toCsv(results));
  else if (extension === ".json") await writeFile(target, JSON.stringify(results, null, 2));
  else await writeDataset(results, target);
}
