import { listSites, loadModel, siteName } from "./registry.js";
import type { Params } from "./runtime/request.js";
import { siteApi } from "./runtime/site-api.js";
import { watch } from "./watch.js";
import { learnLive, undoLive, writeLive } from "./live.js";

// Requests from browser code (the `siteApi` global in the Browser Use Extension's runtime): a
// browser cell, or a watcher's check, can list mapped sites, call or watch their operations, run
// their saved actions and listen on their live channels.

export interface SiteApiRequest {
  siteApi:
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

export function isSiteApiRequest(value: unknown): value is SiteApiRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { siteApi?: unknown }).siteApi === "string"
  );
}

function required(value: unknown, what: string): string {
  if (typeof value !== "string" || !value) throw new Error(`siteApi: give the ${what}`);
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

type Handler = (site: string, request: SiteApiRequest) => Promise<unknown>;

const HANDLERS: Record<Exclude<SiteApiRequest["siteApi"], "sites">, Handler> = {
  operations,
  action: async (site, request) =>
    (await siteApi(site)).action(required(request.name, "action name"), request.params ?? {}),
  channel: async (site, request) =>
    (await siteApi(site)).channel(required(request.name, "channel id"), request.params ?? {}),
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
    (await siteApi(site)).call(required(request.operation, "operation"), request.params ?? {}),
};

export async function handleSiteApiRequest(request: SiteApiRequest): Promise<unknown> {
  if (request.siteApi === "sites") return listSites();
  const handler = HANDLERS[request.siteApi] as Handler | undefined;
  if (!handler) throw new Error(`siteApi: unknown request ${String(request.siteApi)}`);
  return handler(siteName(required(request.site, "site")), request);
}
