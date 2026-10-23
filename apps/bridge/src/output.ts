// Output for the command line: a line of text, a JSON document, or a table of rows.
export function out(text: string): void {
  process.stdout.write(text + "\n");
}

export function printJson(value: unknown): void {
  out(typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value)));
}

/** One row per line, tab-separated: easy to read, easy to cut. */
export function printRows(rows: (string | number | undefined)[][]): void {
  for (const row of rows) out(row.map((cell) => String(cell ?? "")).join("\t"));
}

export function printError(error: unknown): void {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
}
