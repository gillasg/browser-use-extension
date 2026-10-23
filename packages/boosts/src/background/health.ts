import { nextHealth } from "../shared/health.js";
import type { HealthReport } from "../shared/types.js";
import { getHealth, log, setHealth } from "./store.js";

// Records what each boost did on each visit, and asks for a repair when one breaks.

type BrokenListener = (boostId: string, tabId: number | undefined) => void;
const listeners: BrokenListener[] = [];

export function onBroken(listener: BrokenListener): void {
  listeners.push(listener);
}

let chain: Promise<unknown> = Promise.resolve();

/** Health writes run one at a time, so reports from the page and the script do not race. */
export function recordHealth(boostId: string, report: HealthReport, tabId?: number): Promise<void> {
  const run = chain.then(async () => {
    const previous = await getHealth(boostId);
    const next = nextHealth(previous, report);
    await setHealth(boostId, next);
    if (next.status === "broken" && previous.status !== "broken") {
      log({
        level: "warn",
        boostId,
        url: report.url,
        message: `Stopped working${next.broken?.length ? `: ${next.broken.join(", ")} no longer match` : ""}`,
      });
      for (const listener of listeners) listener(boostId, tabId);
    }
  });
  chain = run.catch(() => undefined);
  return run;
}
