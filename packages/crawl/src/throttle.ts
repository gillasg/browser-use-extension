import { getHeapStatistics } from "node:v8";

// Throughput without hurting the site or the user's account: a per-host delay that adapts to
// how fast the site answers (and backs off hard on 429 and 503, honouring Retry-After), a global
// concurrency limit, and a dispatcher that lowers concurrency when memory runs short.

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface HostState {
  next: number;
  delay: number;
}

export class HostThrottle {
  private readonly hosts = new Map<string, HostState>();

  constructor(
    private readonly baseDelay = 250,
    private readonly auto = true,
  ) {}

  private state(host: string): HostState {
    let state = this.hosts.get(host);
    if (!state) {
      state = { next: 0, delay: this.baseDelay };
      this.hosts.set(host, state);
    }
    return state;
  }

  /** Waits for this host's turn. */
  async wait(host: string): Promise<void> {
    const state = this.state(host);
    const now = Date.now();
    const at = Math.max(now, state.next);
    state.next = at + state.delay;
    if (at > now) await sleep(at - now);
  }

  /** Learns from a response: slower sites get more time between requests. */
  observe(host: string, latencyMs: number, status: number, retryAfter?: string): void {
    const state = this.state(host);
    if (status === 429 || status === 503) {
      const asked = retryAfter ? retryAfterMs(retryAfter) : 0;
      state.delay = Math.min(60_000, Math.max(state.delay * 2, asked, 1000));
      state.next = Date.now() + Math.max(asked, state.delay);
      return;
    }
    if (!this.auto) return;
    const target = Math.max(this.baseDelay, latencyMs / 2);
    state.delay = Math.round((state.delay * 3 + target) / 4);
  }

  delay(host: string): number {
    return this.state(host).delay;
  }
}

export function retryAfterMs(value: string): number {
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 120_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(Math.max(0, date - Date.now()), 120_000) : 0;
}

/** How many fetches may run now: the configured limit, halved while memory is tight. */
export function allowedConcurrency(limit: number): number {
  const heap = getHeapStatistics();
  const used = heap.used_heap_size / heap.heap_size_limit;
  if (used > 0.85) return 1;
  if (used > 0.7) return Math.max(1, Math.floor(limit / 2));
  return limit;
}

export const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);
