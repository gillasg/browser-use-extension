import { listSites, loadModel, siteName } from "./registry.js";
import type { Params } from "./runtime/request.js";
import { siteMapper } from "./runtime/site-mapper.js";
import { watch } from "./watch.js";
import { learnLive, undoLive, writeLive } from "./live.js";

// Requests from browser code (the `siteMapper` global in the Browser Use Extension's runtime): a
// browser cell, or a watcher's check, can list mapped sites, call or watch their operations, run
// their saved actions and listen on their live channels.

export interface SiteMapperRequest {
  siteMapper:
    | "sites"
    | "operations"
    | "call"
    | "watch"
    | "action"
    | "channel"
    | "learn-live"
    | "write"
    | "undo";
  site?: string;
  operation?: string;
  params?: Params;
  key?: string;
  items?: string;
  name?: string;
  /** learn-live: the capture of one step (HAR, entries tagged with _step). */
  har?: unknown;
  /** learn-live: the page asked the user to approve what this capture did. */
  approved?: boolean;
}

export function isSiteMapperRequest(value: unknown): value is SiteMapperRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { siteMapper?: unknown }).siteMapper === "string"
  );
}

function required(value: unknown, what: string): string {
  if (typeof value !== "string" || !value) throw new Error(`siteMapper: give the ${what}`);
  return value;
}

async function operations(site: string): Promise<unknown> {
  const model = await loadModel(site);
  if (!model) throw new Error(`${site} is not mapped yet`);
  return model.operations.map((op) => ({
    id: op.id,
    what: op.summary,
    method: op.method,
    path: op.path,
    ...(op.role === "action" ? { writes: true } : {}),
    ...(op.steps?.[0] ? { sentBy: op.steps[0] } : {}),
    params: op.params.filter((p) => !p.constant && !p.generated).map((p) => p.name),
  }));
}

type Handler = (site: string, request: SiteMapperRequest) => Promise<unknown>;

const HANDLERS: Record<Exclude<SiteMapperRequest["siteMapper"], "sites">, Handler> = {
  operations,
  action: async (site, request) =>
    (await siteMapper(site)).action(required(request.name, "action name"), request.params ?? {}),
  channel: async (site, request) =>
    (await siteMapper(site)).channel(required(request.name, "channel id"), request.params ?? {}),
  watch: (site, request) =>
    watch(site, required(request.operation, "operation"), request.params ?? {}, {
      ...(request.key ? { key: request.key } : {}),
      ...(request.items ? { items: request.items } : {}),
      ...(request.name ? { name: request.name } : {}),
    }),
  "learn-live": (site, request) =>
    learnLive(site, request.har, { approved: request.approved === true }),
  write: (site, request) =>
    writeLive(site, required(request.operation, "operation"), request.params ?? {}),
  undo: (site, request) =>
    undoLive(site, required(request.operation, "operation"), request.params ?? {}),
  call: async (site, request) =>
    (await siteMapper(site)).call(required(request.operation, "operation"), request.params ?? {}),
};

export async function handleSiteMapperRequest(request: SiteMapperRequest): Promise<unknown> {
  if (request.siteMapper === "sites") return listSites();
  const handler = HANDLERS[request.siteMapper] as Handler | undefined;
  if (!handler) throw new Error(`siteMapper: unknown request ${String(request.siteMapper)}`);
  return handler(siteName(required(request.site, "site")), request);
}
