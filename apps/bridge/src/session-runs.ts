import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { dataDirectory } from "./paths.js";

// One compact log per run, in the session's folder: the tabs it opened and closed, the hosts it
// contacted, the files it wrote and the jobs it started. A run's answer names it
// ("run log: sessions/<session>/runs/<time>.json"), so the user or a later agent can read back
// what a run actually did without replaying the journal.

export interface RunLogInputs {
  session: string;
  startedAt: number;
  durationMs: number;
  isError: boolean;
  /** Workspace files this run wrote. */
  files: readonly string[];
  result: Record<string, unknown>;
}

/** Where a run's log goes, relative to the data directory; known before it is written. */
export function runLogPath(session: string, at = new Date()): string {
  const stamp = at.toISOString().replace(/[:.]/g, "-");
  return ["sessions", session, "runs", `${stamp}.json`].join("/");
}

export async function writeRunLog(relative: string, inputs: RunLogInputs): Promise<void> {
  const steps = Array.isArray(inputs.result.steps)
    ? (inputs.result.steps as Record<string, unknown>[])
    : [];
  const summary = {
    session: inputs.session,
    startedAt: new Date(inputs.startedAt).toISOString(),
    durationMs: inputs.durationMs,
    ...(inputs.isError ? { failed: true } : {}),
    tabs: tabsOf(inputs.result),
    hosts: hostsOf(steps),
    files: inputs.files.map((file) => basename(file)),
    jobs: jobIdsOf(inputs.result),
  };
  const path = join(dataDirectory(), relative);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(summary, null, 2));
}

function tabsOf(result: Record<string, unknown>): Record<string, unknown> {
  const stats = (result.tabStats ?? {}) as Record<string, unknown>;
  const opened = Array.isArray(result.opened) ? result.opened.length : 0;
  const mine = Array.isArray(stats.mine) ? stats.mine : [];
  return {
    opened: Number(stats.opened ?? opened),
    closed: Number(stats.closed ?? 0),
    open: mine.length,
    ...(mine.length ? { ids: mine } : {}),
  };
}

/** Hosts this run asked for: navigation, opens and tab URLs in its steps. */
function hostsOf(steps: Record<string, unknown>[]): string[] {
  const hosts = new Set<string>();
  for (const step of steps) {
    const action = step.action as { url?: unknown } | undefined;
    const tab = (step.result as { tab?: { url?: unknown } } | undefined)?.tab;
    for (const url of [action?.url, tab?.url]) {
      const host = hostOf(url);
      if (host) hosts.add(host);
    }
  }
  return [...hosts];
}

export function hostOf(url: unknown): string | undefined {
  if (typeof url !== "string" || !url) return undefined;
  try {
    const host = new URL(url).hostname;
    return host || undefined;
  } catch {
    return undefined;
  }
}

/** Jobs a run started: browser.job returns {jobId} in the value or the printed output. */
function jobIdsOf(result: Record<string, unknown>): string[] {
  const text = JSON.stringify(result.value ?? result.output ?? "").slice(0, 200_000);
  const ids = new Set<string>();
  for (const match of text.matchAll(/jobId\\?"?\s*:\s*\\?"([0-9a-f-]{36})/g))
    if (match[1]) ids.add(match[1]);
  return [...ids];
}
