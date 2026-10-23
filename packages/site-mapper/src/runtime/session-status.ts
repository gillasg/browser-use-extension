// Before a caller spends a turn: is there a session to call with, and will it still work?
// An agent that knows this can choose the browser instead of failing halfway.

import { readSession } from "../registry.js";

export interface SessionStatus {
  site: string;
  /** True when a session was exported, so calls can run from Node without the browser. */
  exported: boolean;
  savedAt?: string;
  ageHours?: number;
  /** False when the export is old enough that the next call may be refused. */
  fresh: boolean;
  /** One line the caller can show or act on. */
  note: string;
}

/** Matches the runtime's own freshness window. */
const FRESH_HOURS = 12;

export async function sessionStatus(site: string): Promise<SessionStatus> {
  const session = await readSession(site);
  if (!session || !session.savedAt)
    return {
      site,
      exported: false,
      fresh: false,
      note: `No exported session for ${site}: calls run in the user's browser, which must be open and signed in. Export one with the session action to call from Node.`,
    };
  const ageHours = Math.max(0, Math.round((Date.now() - Date.parse(session.savedAt)) / 3_600_000));
  const fresh = ageHours < FRESH_HOURS;
  return {
    site,
    exported: true,
    savedAt: session.savedAt,
    ageHours,
    fresh,
    note: fresh
      ? `Session exported ${ageHours}h ago: direct calls should work.`
      : `Session exported ${ageHours}h ago: the next call may be refused and renewed from the browser.`,
  };
}
