import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { filterExchanges } from "./filter.js";
import { parseCapture } from "./load/index.js";
import { learnedNoise, loadModel, saveFlow, siteDir, siteName, writeAtomic } from "./registry.js";
import type { Params, RuntimeResponse } from "./runtime/request.js";
import { HttpError, siteMapper } from "./runtime/site-mapper.js";
import type { Exchange, Operation } from "./types.js";
import { rebuild } from "./workflow.js";

// Learning while working: a browser tool records the site's own requests while it uses a site,
// each tagged with the page step that sent it, and hands the capture over after every step.
// The API is rebuilt from it at once (no model), and the new operations are announced so the
// rest of the task can call them. A write may go through the API only after the page has made
// the same write successfully (the capture proves it) and only if it is routine; anything
// consequential stays in the page, where the user approves it.

export type WriteKind = "routine" | "consequential";

export interface LearnedOperation {
  id: string;
  role: Operation["role"];
  /** For writes: may it be repeated through the API once proven? */
  kind?: WriteKind;
  /** The page step that sent it. */
  step?: string;
  /** A write the page has just made successfully: siteMapper.write may repeat it. */
  proven?: boolean;
  /** This cell's own action sent it (not an unrelated page-load request). */
  related?: boolean;
  params: string[];
  /** Inputs that change per item, and where their values came from. */
  varies: string[];
  how: string;
}

export interface LiveLearnResult {
  site: string;
  learned: LearnedOperation[];
}

interface LiveState {
  /** Writes the page proved: the request shape they were proven with. */
  proofs: Record<string, { at: number; shape: string; step?: string }>;
  /** Writes the page asked the user to approve: never through the API. */
  approved: string[];
  /** Routine writes and their learned reverse, for Undo in Activity. */
  reverse: Record<string, string>;
}

const CONSEQUENTIAL =
  /\b(pay|payment|checkout|check out|order|purchase|buy|place order|send|message|reply|comment|post|publish|tweet|share|submit|confirm|transfer|withdraw|donate|book|reserve|subscribe|unsubscribe|account|password|email|invite|apply|delete)\b/i;
const ROUTINE =
  /\b(remove|add|save|unsave|mark|read|unread|label|tag|star|unstar|like|unlike|follow|unfollow|archive|unarchive|bookmark|pin|unpin|move|rename|watch later|playlist|hide|mute|unmute|dismiss|snooze|rate|vote|upvote|downvote|favou?rite|wishlist|cart|seen|watched)\b/i;

/**
 * Routine writes (remove from a list, mark read, star, follow) may be repeated through the API
 * once proven. Anything that pays, orders, sends, posts, deletes or touches the account is
 * consequential, and so is anything unclear.
 */
export function writeKind(operation: Operation, approved: readonly string[] = []): WriteKind {
  if (approved.includes(operation.id)) return "consequential";
  const text = [operation.id.replace(/([a-z])([A-Z])/g, "$1 $2"), ...(operation.steps ?? [])]
    .join(" ")
    .concat(" ", operation.path.replace(/[/_-]+/g, " "));
  if (CONSEQUENTIAL.test(text)) return "consequential";
  return ROUTINE.test(text) ? "routine" : "consequential";
}

/** What a proof is tied to: when the request's shape changes, the proof no longer holds. */
export function requestShape(operation: Operation): string {
  const properties = Object.keys(
    ((operation.requestBody?.schema as { properties?: object } | undefined)?.properties ??
      {}) as object,
  ).sort();
  return [operation.method, operation.origin + operation.path, ...properties].join(" ");
}

const statePath = (site: string) => join(siteDir(site), "live.json");

async function readState(site: string): Promise<LiveState> {
  try {
    const state = JSON.parse(await readFile(statePath(site), "utf8")) as Partial<LiveState>;
    return {
      proofs: state.proofs ?? {},
      approved: state.approved ?? [],
      reverse: state.reverse ?? {},
    };
  } catch {
    return { proofs: {}, approved: [], reverse: {} };
  }
}

/** Learns from one step's capture: saves it as a flow, rebuilds, and reports what is new. */
export async function learnLive(
  site: string,
  har: unknown,
  options: { approved?: boolean } = {},
): Promise<LiveLearnResult> {
  const name = siteName(site);
  const kept = filterExchanges(parseCapture(JSON.stringify(har), "live"), {
    origins: [name],
    noise: await learnedNoise(),
  }).kept;
  if (!kept.length) return { site: name, learned: [] };
  const before = await loadModel(name);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const flow = `live-${stamp}`;
  await saveFlow(name, { name: flow, recordedAt: new Date().toISOString() }, har);
  const { model } = await rebuild(name);
  const touched = model.operations.filter((operation) => operation.sources.includes(flow));
  const state = await readState(name);
  const wasProven = new Set(Object.keys(state.proofs));
  const sent = kept.map((item) => item.exchange);
  for (const operation of touched) noteProof(operation, sent, state, options.approved === true);
  state.reverse = reversePairs(model.operations, state.approved);
  await saveState(name, state);
  // News: an operation seen for the first time, or a write the page has just proven.
  const isNews = (operation: Operation) =>
    !before?.operations.some((item) => item.id === operation.id) ||
    (state.proofs[operation.id] !== undefined && !wasProven.has(operation.id));
  return {
    site: name,
    learned: touched.filter(isNews).map((operation) => describe(name, operation, state, sent)),
  };
}

function saveState(site: string, state: LiveState): Promise<void> {
  return writeAtomic(statePath(site), JSON.stringify(state, null, 2), 0o600);
}

/** A write the page just made successfully is proven; one that failed proves nothing. */
function noteProof(
  operation: Operation,
  sent: Exchange[],
  state: LiveState,
  approved: boolean,
): void {
  if (operation.role !== "action") return;
  if (approved && !state.approved.includes(operation.id)) state.approved.push(operation.id);
  const pattern = templatePattern(operation);
  const mine = sent.filter(
    (exchange) => exchange.method === operation.method && pattern.test(pathOf(exchange.url)),
  );
  const step = mine.find((exchange) => exchange.step)?.step;
  if (!step || !mine.length) return;
  if (mine.every((exchange) => exchange.status >= 200 && exchange.status < 300))
    state.proofs[operation.id] = { at: Date.now(), shape: requestShape(operation), step };
  else delete state.proofs[operation.id];
}

function describe(
  site: string,
  operation: Operation,
  state: LiveState,
  sent: Exchange[],
): LearnedOperation {
  const params = inputs(operation);
  const varies = operation.dependencies
    .filter((dependency) => dependency.source.kind === "response")
    .map((dependency) => {
      const source = dependency.source as { operationId: string; pointer: string };
      return `${dependency.target.replace(/^\w+:/, "")} comes from ${source.operationId} ${source.pointer}`;
    })
    .slice(0, 4);
  const example = `{${params.map((param) => param + ": …").join(", ")}}`;
  const kind = operation.role === "action" ? writeKind(operation, state.approved) : undefined;
  const proven = kind === "routine" && state.proofs[operation.id] !== undefined;
  const step = operation.steps?.[0];
  const pattern = templatePattern(operation);
  const related = sent.some(
    (exchange) =>
      !!exchange.step && exchange.method === operation.method && pattern.test(pathOf(exchange.url)),
  );
  return {
    id: operation.id,
    role: operation.role,
    ...(kind ? { kind } : {}),
    ...(step ? { step } : {}),
    ...(proven ? { proven } : {}),
    ...(related ? { related } : {}),
    params,
    varies,
    how:
      operation.role === "read"
        ? `await siteMapper.call('${site}', '${operation.id}', ${example})`
        : proven
          ? `await siteMapper.write('${site}', '${operation.id}', ${example}); many items: await siteMapper.batch('${site}', '${operation.id}', items)`
          : kind === "consequential"
            ? "consequential: keep doing it in the page, where the user approves it"
            : "do it once in the page; when that works, siteMapper.write can repeat it",
  };
}

function inputs(operation: Operation): string[] {
  const params = operation.params
    .filter(
      (param) =>
        !param.constant && !param.generated && param.in !== "header" && param.in !== "cookie",
    )
    .map((param) => param.name);
  const body = Object.keys(
    ((operation.requestBody?.schema as { properties?: object } | undefined)?.properties ??
      {}) as object,
  );
  return [...new Set([...params, ...body])].slice(0, 12);
}

export class NotProven extends Error {
  constructor(operationId: string, reason: string) {
    super(`${operationId}: ${reason}`);
    this.name = "NotProven";
  }
}

/** Repeats a proven routine write through the API. A failure withdraws the proof. */
export async function writeLive(
  site: string,
  operationId: string,
  params: Params = {},
): Promise<unknown> {
  const name = siteName(site);
  const model = await loadModel(name);
  const operation = model?.operations.find((item) => item.id === operationId);
  if (!model || !operation) throw new Error(`${name} has no operation ${operationId}`);
  const api = await siteMapper(name, { model, transport: "page" });
  if (operation.role === "read") return api.call(operationId, params);
  const state = await readState(name);
  assertWritable(operation, state);
  const response = await api.write(operationId, params);
  if (response.status === 429) throw new HttpError(operationId, response);
  if (response.status >= 400 || response.status === 0) {
    delete state.proofs[operationId];
    await saveState(name, state);
    const error = new HttpError(operationId, response);
    error.message += ". The API no longer does this: continue in the page; that run repairs it.";
    throw error;
  }
  return response.json ?? response.text ?? { ok: true, status: response.status };
}

/**
 * Reverses a routine write that went through the API, when the site also exposes the opposite
 * action (remove ↔ add, follow ↔ unfollow). It is used by Undo in Activity. The forward write
 * had to succeed through the API first; the reverse is then sent with the same item values.
 */
export async function undoLive(
  site: string,
  operationId: string,
  params: Params = {},
): Promise<unknown> {
  const { name, model, state, reverseId } = await undoTarget(site, operationId);
  const api = await siteMapper(name, { model, transport: "page" });
  const response = await api.write(reverseId, params);
  if (response.status === 429) throw new HttpError(reverseId, response);
  if (response.status >= 400 || response.status === 0)
    throw await undoFailure(name, state, operationId, reverseId, response);
  return response.json ?? response.text ?? { ok: true, status: response.status };
}

/** The forward write, the state that proves it, and the opposite operation to send. */
async function undoTarget(
  site: string,
  operationId: string,
): Promise<{
  name: string;
  model: NonNullable<Awaited<ReturnType<typeof loadModel>>>;
  state: LiveState;
  reverseId: string;
}> {
  const name = siteName(site);
  const model = await loadModel(name);
  const operation = model?.operations.find((item) => item.id === operationId);
  if (!model || !operation) throw new Error(`${name} has no operation ${operationId}`);
  if (operation.role !== "action")
    throw new Error(`${operationId} is a read; there is nothing to undo`);
  const state = await readState(name);
  if (!state.proofs[operationId])
    throw new NotProven(
      operationId,
      "it has not gone through the API, so there is nothing to undo through it; change it back in the page",
    );
  const reverseId = state.reverse[operationId];
  if (!reverseId)
    throw new Error(`${operationId} has no learned reverse; change it back in the page`);
  const reverse = model.operations.find((item) => item.id === reverseId);
  if (!reverse || writeKind(reverse, state.approved) !== "routine")
    throw new Error(`${reverseId} is not a routine write; change it back in the page`);
  return { name, model, state, reverseId };
}

/** The API refused the reverse: forget the pair and tell the agent to use the page. */
async function undoFailure(
  name: string,
  state: LiveState,
  operationId: string,
  reverseId: string,
  response: RuntimeResponse,
): Promise<HttpError> {
  delete state.reverse[operationId];
  delete state.reverse[reverseId];
  await saveState(name, state);
  const error = new HttpError(reverseId, response);
  error.message += ". The API refused the reverse: change it back in the page.";
  return error;
}

/** The opposite of a routine write, by name: addToWatchLater ↔ removeFromWatchLater, and so on. */
const INVERSE = new Map<string, string>([
  ["add", "remove"],
  ["remove", "add"],
  ["follow", "unfollow"],
  ["unfollow", "follow"],
  ["like", "unlike"],
  ["unlike", "like"],
  ["save", "unsave"],
  ["unsave", "save"],
  ["star", "unstar"],
  ["unstar", "star"],
  ["mark", "unmark"],
  ["unmark", "mark"],
  ["mute", "unmute"],
  ["unmute", "mute"],
  ["block", "unblock"],
  ["unblock", "block"],
  ["subscribe", "unsubscribe"],
  ["unsubscribe", "subscribe"],
  ["pin", "unpin"],
  ["unpin", "pin"],
  ["read", "unread"],
  ["unread", "read"],
  ["archive", "unarchive"],
  ["unarchive", "archive"],
  ["hide", "unhide"],
  ["unhide", "hide"],
  ["favorite", "unfavorite"],
  ["unfavorite", "favorite"],
  ["favourite", "unfavourite"],
  ["unfavourite", "favourite"],
  ["join", "leave"],
  ["leave", "join"],
  ["accept", "decline"],
  ["decline", "accept"],
  ["enable", "disable"],
  ["disable", "enable"],
]);

/** The verb and the thing it acts on: removeFromWatchLater → {remove, watchlater}. */
function actionWords(id: string): { verb: string; rest: string } | undefined {
  const words = id
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (words.length < 2) return undefined;
  const verb = words[0];
  if (!verb) return undefined;
  const rest = words
    .slice(1)
    .join("")
    .replace(/^(to|from)/, "");
  return rest.length >= 4 ? { verb, rest } : undefined;
}

/** Every routine write paired with its opposite, when both were learned from the site. */
export function reversePairs(
  operations: readonly Operation[],
  approved: readonly string[] = [],
): Record<string, string> {
  const writes = operations.filter(
    (operation) => operation.role === "action" && writeKind(operation, approved) === "routine",
  );
  const pairs: Record<string, string> = {};
  for (const operation of writes) {
    const shape = actionWords(operation.id);
    const inverse = shape ? INVERSE.get(shape.verb) : undefined;
    if (!shape || !inverse) continue;
    const opposite = writes.find((candidate) => {
      if (candidate.id === operation.id) return false;
      const other = actionWords(candidate.id);
      return other?.verb === inverse && other.rest === shape.rest;
    });
    if (!opposite) continue;
    pairs[operation.id] = opposite.id;
    pairs[opposite.id] = operation.id;
  }
  return pairs;
}

function assertWritable(operation: Operation, state: LiveState): void {
  if (writeKind(operation, state.approved) === "consequential")
    throw new NotProven(
      operation.id,
      "this changes something that matters (pays, orders, sends, posts, deletes or touches the account, or the page asked the user to approve it); do it in the page, where the user approves it",
    );
  const proof = state.proofs[operation.id];
  if (!proof || proof.shape !== requestShape(operation))
    throw new NotProven(
      operation.id,
      "not proven yet: do it once in the page; when that works, the recording proves it and siteMapper.write can repeat it",
    );
}

function templatePattern(operation: Operation): RegExp {
  const escaped = operation.path
    .split(/\{[^}]+\}/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]+");
  return new RegExp(`^${escaped}/?$`);
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}
