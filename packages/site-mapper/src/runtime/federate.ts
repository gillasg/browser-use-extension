// Cross-site fan-out: the same question to several mapped sites at once, merged into one answer.
//
//   const { items, misses } = await federate(
//     [
//       { site: "shop.example", operation: "searchProducts", params: { q: "lamp" } },
//       { site: "other.example", operation: "search", params: { q: "lamp" }, label: "other" },
//     ],
//     { keyBy: "id", timeoutMs: 5000 },
//   );
//
// One site failing, timing out or being signed out never fails the answer: it lands in `misses`
// with its kind, and every item that did arrive keeps the site it came from.

import { getPointer } from "../infer/schema.js";
import type { Params } from "./request.js";
import { errorKind, siteMapper, type ErrorKind, type SiteMapper } from "./site-mapper.js";

/** One site's question: what to call, and with which inputs. */
export interface FederateTarget {
  site: string;
  operation: string;
  params?: Params;
  /** A name for this target in provenance and misses (default: the site). */
  label?: string;
}

/** What federate needs from a client, so tests and other runtimes can hand one in. */
export interface FederateClient {
  call(id: string, params?: Params): Promise<unknown>;
}

/** An item, with the site that answered it. */
export interface FederatedItem {
  item: unknown;
  site: string;
  label: string;
  operation: string;
  /** How long that site took to answer. */
  elapsedMs: number;
}

/** A site that did not answer, and why. */
export interface FederateMiss {
  site: string;
  label: string;
  operation: string;
  /** `signed-out`, `missing-input`, `broken`, `failed`, `browser-offline`, or `timeout`. */
  kind: ErrorKind | "timeout";
  error: string;
  elapsedMs: number;
}

/** A site that answered, including with no items at all. */
export interface FederateAnswer {
  site: string;
  label: string;
  operation: string;
  count: number;
  elapsedMs: number;
}

export interface FederateResult {
  /** Every item, in the order the sites answered, each tagged with its provenance. */
  items: FederatedItem[];
  misses: FederateMiss[];
  answered: FederateAnswer[];
  /** Items dropped because another site answered with the same key first. */
  duplicates: number;
  elapsedMs: number;
}

export interface FederateOptions {
  /** Where the items live in a response ("/results/items", or "results.items"); default: the response, or its first array. */
  items?: string;
  /** The field that identifies an item, or a function returning it. Without one, nothing is merged. */
  keyBy?: string | ((item: unknown) => unknown);
  /** Normalizes a key before matching. Default: trimmed, lower case. */
  normalize?: (key: string) => string;
  /** Builds one value from items that share a key (same film on three sites). Default: keep the first. */
  merge?: (group: FederatedItem[]) => unknown;
  /** Milliseconds each site gets before it counts as a timeout. Default 8000. */
  timeoutMs?: number;
  /** Sites asked at once. Default 4. */
  concurrency?: number;
  /** Stop starting sites once one has answered with items. */
  firstWins?: boolean;
  /** Called as each site answers, for live progress. */
  onAnswer?: (answer: FederateAnswer, items: FederatedItem[]) => void;
  /** The client for a target; default: `siteMapper(site)`, one per site and reused across the call. */
  client?: (target: FederateTarget) => Promise<FederateClient>;
}

/** The keys a response commonly keeps its list under, most specific first. */
const ITEM_KEYS = ["items", "results", "data", "hits", "list", "entries", "edges"];

class Timeout extends Error {
  constructor(ms: number) {
    super(`no answer in ${ms}ms`);
    this.name = "Timeout";
  }
}

function within<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Timeout(ms)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function arrayOf(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

/** Accepts a JSON pointer (/results/items) or a dotted path (results.items). */
function asPointer(pointer: string): string {
  if (pointer.startsWith("/")) return pointer;
  return `/${pointer.split(".").filter(Boolean).join("/")}`;
}

/** The items in a response: at a pointer when given, else the response or the first list in it. */
function extractItems(response: unknown, pointer?: string): unknown[] {
  if (pointer !== undefined) return arrayOf(getPointer(response, asPointer(pointer))) ?? [];
  const itself = arrayOf(response);
  if (itself) return itself;
  if (!response || typeof response !== "object") return [];
  const record = response as Record<string, unknown>;
  for (const key of ITEM_KEYS) {
    const found = arrayOf(record[key]);
    if (found) return found;
  }
  for (const value of Object.values(record)) {
    const found = arrayOf(value);
    if (found) return found;
  }
  return [];
}

function normalizeKey(key: string): string {
  return key.trim().toLowerCase();
}

/** The normalized key of an item, or undefined when the caller gave nothing to key on. */
function keyFor(
  item: unknown,
  keyBy?: string | ((item: unknown) => unknown),
  normalize = normalizeKey,
): string | undefined {
  if (!keyBy) return undefined;
  const raw =
    typeof keyBy === "function"
      ? keyBy(item)
      : (item as Record<string, unknown> | null | undefined)?.[keyBy];
  if (raw === undefined || raw === null || raw === "") return undefined;
  return normalize(String(raw));
}

function clientFactory(
  options: FederateOptions,
): (target: FederateTarget) => Promise<FederateClient> {
  if (options.client) return options.client;
  const clients = new Map<string, Promise<SiteMapper>>();
  return (target) => {
    const existing = clients.get(target.site);
    if (existing) return existing;
    const created = siteMapper(target.site);
    clients.set(target.site, created);
    return created;
  };
}

type Outcome =
  | { kind: "answer"; answer: FederateAnswer; items: FederatedItem[] }
  | { kind: "miss"; miss: FederateMiss };

/** Asks one site; never throws: a failure becomes a miss with its kind. */
async function ask(
  target: FederateTarget,
  options: FederateOptions,
  makeClient: (target: FederateTarget) => Promise<FederateClient>,
): Promise<Outcome> {
  const label = target.label ?? target.site;
  const startedAt = Date.now();
  try {
    const client = await makeClient(target);
    const response = await within(
      client.call(target.operation, target.params ?? {}),
      options.timeoutMs ?? 8000,
    );
    const elapsedMs = Date.now() - startedAt;
    const items = extractItems(response, options.items).map((item) => ({
      item,
      site: target.site,
      label,
      operation: target.operation,
      elapsedMs,
    }));
    return {
      kind: "answer",
      answer: {
        site: target.site,
        label,
        operation: target.operation,
        count: items.length,
        elapsedMs,
      },
      items,
    };
  } catch (error) {
    return {
      kind: "miss",
      miss: {
        site: target.site,
        label,
        operation: target.operation,
        kind: error instanceof Timeout ? "timeout" : errorKind(error),
        error: error instanceof Error ? error.message : String(error),
        elapsedMs: Date.now() - startedAt,
      },
    };
  }
}

interface Collector {
  items: FederatedItem[];
  index: Map<string, number>;
  groups: Map<string, FederatedItem[]>;
  duplicates: number;
}

function collect(
  collector: Collector,
  entry: FederatedItem,
  keyFromItem: string | undefined,
): void {
  if (keyFromItem === undefined) {
    collector.items.push(entry);
    return;
  }
  const at = collector.index.get(keyFromItem);
  if (at === undefined) {
    collector.index.set(keyFromItem, collector.items.length);
    collector.items.push(entry);
    collector.groups.set(keyFromItem, [entry]);
    return;
  }
  collector.duplicates += 1;
  collector.groups.get(keyFromItem)?.push(entry);
}

/** Replaces the first copy of each shared key with the merged value. */
function applyMerge(collector: Collector, merge?: (group: FederatedItem[]) => unknown): void {
  if (!merge) return;
  for (const [keyFromItem, group] of collector.groups) {
    const at = collector.index.get(keyFromItem);
    const first = group[0];
    if (at === undefined || !first || group.length < 2) continue;
    collector.items[at] = { ...first, item: merge(group) };
  }
}

/** Runs the targets, at most `limit` at once, until they are done or `done()` says stop. */
async function race(
  targets: FederateTarget[],
  limit: number,
  done: () => boolean,
  work: (target: FederateTarget) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, targets.length)) }, async () => {
    while (next < targets.length && !done()) {
      const target = targets[next];
      next += 1;
      if (target) await work(target);
    }
  });
  await Promise.all(workers);
}

/**
 * Asks several sites the same question at once and returns one answer with provenance.
 * Order follows the sites that answered; a slow site is a `timeout` miss, not a failure.
 */
export async function federate(
  targets: FederateTarget[],
  options: FederateOptions = {},
): Promise<FederateResult> {
  const startedAt = Date.now();
  const makeClient = clientFactory(options);
  const answers: FederateAnswer[] = [];
  const misses: FederateMiss[] = [];
  const collector: Collector = { items: [], index: new Map(), groups: new Map(), duplicates: 0 };
  await race(
    targets,
    options.concurrency ?? 4,
    () => Boolean(options.firstWins && answers.length > 0),
    async (target) => {
      const outcome = await ask(target, options, makeClient);
      if (outcome.kind === "miss") {
        misses.push(outcome.miss);
        return;
      }
      answers.push(outcome.answer);
      for (const entry of outcome.items)
        collect(collector, entry, keyFor(entry.item, options.keyBy, options.normalize));
      options.onAnswer?.(outcome.answer, outcome.items);
    },
  );
  applyMerge(collector, options.merge);
  return {
    items: collector.items,
    misses,
    answered: answers,
    duplicates: collector.duplicates,
    elapsedMs: Date.now() - startedAt,
  };
}
