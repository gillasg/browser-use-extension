import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dataDirectory } from "./paths.js";

// Durable bridge state: which targets belong to which named session, plus one JSON line per
// execute call so a run can be audited after a crash or restart. Best-effort: a journal failure
// never fails the browser call it describes.
export interface JournalTarget {
  clientInstanceId: string;
  browserRunId: string;
  tabId: number;
  tabIncarnation: string;
}

export interface JournalEntry {
  ts: string;
  sessionId: string;
  code: string;
  isError: boolean;
  durationMs: number;
  resultPreview: string;
  opened: number;
}

const sessionsFile = (): string => join(dataDirectory(), "sessions.json");
const journalFile = (session: string): string =>
  join(dataDirectory(), "sessions", session, "journal.jsonl");

export async function loadSessionTargets(): Promise<Record<string, JournalTarget[]>> {
  try {
    const text = await readFile(sessionsFile(), "utf8");
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" && value !== null
      ? (value as Record<string, JournalTarget[]>)
      : {};
  } catch {
    return {};
  }
}

export async function saveSessionTargets(sessions: Record<string, JournalTarget[]>): Promise<void> {
  const path = sessionsFile();
  await mkdir(dataDirectory(), { recursive: true });
  const temporary = path + "." + randomUUID() + ".tmp";
  await writeFile(temporary, JSON.stringify(sessions, null, 2), { flag: "wx", mode: 0o600 });
  await rename(temporary, path);
}

export async function appendJournalEntry(entry: JournalEntry): Promise<void> {
  const file = journalFile(entry.sessionId);
  await mkdir(join(dataDirectory(), "sessions", entry.sessionId), { recursive: true });
  await appendFile(file, JSON.stringify(entry) + "\n", "utf8");
}

export async function readJournalEntries(session: string, limit: number): Promise<JournalEntry[]> {
  try {
    const raw = await readFile(journalFile(session), "utf8");
    return raw
      .split("\n")
      .filter((line) => line.trim())
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as JournalEntry];
        } catch {
          return [];
        }
      })
      .slice(-Math.max(1, Math.min(limit, 500)));
  } catch {
    return [];
  }
}

export function truncateForJournal(text: string, max: number): string {
  return text.length <= max
    ? text
    : text.slice(0, max) + "… [truncated " + (text.length - max) + " chars]";
}
