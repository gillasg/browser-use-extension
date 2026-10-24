// Turns a cell result into text for an agent, plus the screenshots it captured.
type Json = Record<string, unknown>;
const MAX_TEXT = 60_000;

export function formatResult(result: Json): {
  text: string;
  images: { data: string; mimeType: string }[];
} {
  const parts: string[] = [];
  if (typeof result.output === "string" && result.output.trim())
    parts.push(result.output.trimEnd());
  if (result.value !== undefined) parts.push("→ " + stringify(result.value));
  if (result.error) parts.push("Error: " + String(result.error));
  if (result.reset) parts.push("(The REPL was reset; variables from earlier cells are gone.)");
  const stats = result.tabStats as
    | { opened?: number; closed?: number; mine?: number[]; total?: number; popups?: number }
    | undefined;
  if (stats)
    parts.push(
      `tabs: opened ${stats.opened ?? 0}, closed ${stats.closed ?? 0}, mine ${stats.mine?.length ?? 0}` +
        `${stats.mine?.length ? ` (${stats.mine.join(", ")})` : ""}, total ${stats.total ?? 0}` +
        `${stats.popups ? `; popups: ${stats.popups} parked` : ""}`,
    );
  let text = parts.join("\n") || "(no output)";
  if (typeof result.runLog === "string") text += "\nrun log: " + result.runLog;
  if (text.length > MAX_TEXT)
    text = text.slice(0, MAX_TEXT) + `\n[... ${text.length - MAX_TEXT} more characters clipped]`;
  const images = ((result.steps as Json[] | undefined) ?? [])
    .map((step) => step.result as Json | undefined)
    .filter(
      (item): item is Json => item?.kind === "screenshot" && typeof item.dataBase64 === "string",
    )
    .slice(-3)
    .map((item) => ({
      data: String(item.dataBase64),
      mimeType: String(item.mimeType ?? "image/png"),
    }));
  return { text, images };
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
