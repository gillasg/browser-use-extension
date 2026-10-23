import type { Boost } from "./types.js";

// Line diffs between revisions, and a stable text form of a boost to diff.

export interface DiffLine {
  kind: " " | "+" | "-";
  text: string;
}

/** A line diff (longest common subsequence; long inputs fall back to a plain replace). */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length * b.length > 4_000_000)
    return [
      ...a.map((text) => ({ kind: "-" as const, text })),
      ...b.map((text) => ({ kind: "+" as const, text })),
    ];
  const lengths = lcsTable(a, b);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: " ", text: a[i] as string });
      i++;
      j++;
    } else if ((lengths[i + 1]?.[j] ?? 0) >= (lengths[i]?.[j + 1] ?? 0))
      out.push({ kind: "-", text: a[i++] as string });
    else out.push({ kind: "+", text: b[j++] as string });
  }
  while (i < a.length) out.push({ kind: "-", text: a[i++] as string });
  while (j < b.length) out.push({ kind: "+", text: b[j++] as string });
  return out;
}

function lcsTable(a: string[], b: string[]): Uint32Array[] {
  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    const row = table[i] as Uint32Array;
    const below = table[i + 1] as Uint32Array;
    for (let j = b.length - 1; j >= 0; j--)
      row[j] =
        a[i] === b[j]
          ? (below[j + 1] as number) + 1
          : Math.max(below[j] as number, row[j + 1] as number);
  }
  return table;
}

/** Only changed lines with a little context, as unified-diff text. */
export function unifiedDiff(before: string, after: string, context = 2): string {
  const lines = diffLines(before, after);
  const keep = new Set<number>();
  lines.forEach((line, index) => {
    if (line.kind === " ") return;
    for (let k = index - context; k <= index + context; k++) keep.add(k);
  });
  const out: string[] = [];
  let skipped = false;
  lines.forEach((line, index) => {
    if (!keep.has(index)) {
      skipped = true;
      return;
    }
    if (skipped) out.push("…");
    skipped = false;
    out.push(`${line.kind} ${line.text}`);
  });
  return out.join("\n");
}

/** The parts of a boost a person edits, as text: what revisions are compared on. */
export function boostText(boost: Boost): string {
  if (boost.source && boost.kind !== "boost") return boost.source;
  const sections: [string, string[]][] = [
    ["CSS", boost.css ? [boost.css] : []],
    [
      "Hidden",
      (boost.zaps ?? []).map(
        (z) => z.selector + (z.contains ? ` (containing "${z.contains}")` : ""),
      ),
    ],
    ["Look", boost.look ? [JSON.stringify(boost.look, null, 2)] : []],
    ["Actions", (boost.actions ?? []).map((a) => JSON.stringify(a))],
    ["Network", (boost.network ?? []).map((r) => JSON.stringify(r))],
    ["HTML", (boost.html ?? []).map((h) => JSON.stringify(h))],
    ["JavaScript", boost.js ? [boost.js] : []],
  ];
  const parts: string[] = [
    `name: ${boost.name}`,
    `sites: ${boost.sites.map((s) => s.value ?? s.type).join(", ")}`,
  ];
  for (const [title, lines] of sections)
    if (lines.length) parts.push("", `/* ${title} */`, ...lines);
  return parts.join("\n");
}
