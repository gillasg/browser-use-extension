import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { Crawl, type CrawlDeps } from "./crawler.js";
import { AutoFetcher } from "./fetch/auto.js";
import { mapSite } from "./map.js";
import { scrape } from "./scrape.js";
import { searchAndScrape, search } from "./search.js";
import { JobStore, listJobs, pruneJobs } from "./store.js";
import type { CrawlEvent, CrawlOptions } from "./types.js";

// The REST job server:
//   POST   /v1/crawl               start a crawl → { id }
//   GET    /v1/crawl/:id           state, stats and results (?cursor=&limit=)
//   DELETE /v1/crawl/:id           cancel
//   POST   /v1/crawl/:id/pause     pause;  POST /v1/crawl/:id/resume  resume
//   GET    /v1/crawl/:id/events    live events (server-sent events); /v1/crawl/:id/ws for WebSocket
//   GET    /v1/crawls              every job
//   POST   /v1/scrape | /v1/map | /v1/search
// Every request needs the token: Authorization: Bearer <token>.

export interface ServerOptions {
  port?: number;
  host?: string;
  token?: string;
  /** Delete finished jobs older than this many days. Default 7. */
  retentionDays?: number;
  deps?: CrawlDeps;
}

export interface CrawlServer {
  url: string;
  token: string;
  close(): Promise<void>;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

class Jobs {
  private readonly live = new Map<string, Crawl>();

  constructor(private readonly deps: CrawlDeps) {}

  start(options: CrawlOptions): Crawl {
    const job = new Crawl(options, this.deps);
    this.live.set(job.id, job);
    void job.start().catch(() => undefined);
    return job;
  }

  get(id: string): Crawl | undefined {
    return this.live.get(id);
  }

  async describe(
    id: string,
    cursor: number,
    limit: number,
  ): Promise<Record<string, unknown> | undefined> {
    const job = this.live.get(id);
    const store = job?.store ?? new JobStore(id);
    const record = await store.readRecord();
    if (!job && !record) return undefined;
    const page = await store.results(cursor, limit);
    return { id, state: job?.state ?? record?.state, stats: job?.stats ?? record?.stats, ...page };
  }
}

function authorized(request: IncomingMessage, token: string): boolean {
  const header =
    String(request.headers.authorization ?? "").replace(/^Bearer\s+/i, "") ||
    String(request.headers["x-browser-crawl-token"] ?? "");
  const given = Buffer.from(header);
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function streamEvents(job: Crawl, response: ServerResponse): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  const listener = (event: CrawlEvent) =>
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  job.on("event", listener);
  response.on("close", () => job.off("event", listener));
}

/** Pause, resume and live events for a running job. */
function liveAction(job: Crawl, action: string | undefined, response: ServerResponse): boolean {
  if (action === "events") streamEvents(job, response);
  else if (action === "pause") {
    job.pause();
    send(response, 200, { id: job.id, state: job.state });
  } else if (action === "resume") {
    void job.resume().catch(() => undefined);
    send(response, 200, { id: job.id, state: "running" });
  } else return false;
  return true;
}

/** The ?cursor= and ?limit= of a results request. */
function page(url: URL): [number, number] {
  const cursor = Number(url.searchParams.get("cursor") ?? 0);
  return [cursor, Math.min(500, Number(url.searchParams.get("limit") ?? 50))];
}

async function jobRoute(
  jobs: Jobs,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  parts: string[],
): Promise<void> {
  const [, , id, action] = parts;
  if (!id) return send(response, 404, { error: "Not found" });
  const job = jobs.get(id);
  if (request.method === "DELETE") {
    job?.cancel();
    return send(response, job ? 200 : 404, { id, state: job?.state ?? "unknown" });
  }
  if (job && liveAction(job, action, response)) return;
  const described = await jobs.describe(id, ...page(url));
  send(response, described ? 200 : 404, described ?? { error: "No such crawl" });
}

async function actionRoute(
  name: string,
  body: Record<string, unknown>,
  fetcher: AutoFetcher,
): Promise<unknown> {
  if (name === "scrape") return scrape(String(body.url), body as CrawlOptions, { fetcher });
  if (name === "map") return mapSite(String(body.url), body);
  if (name === "search")
    return body.scrape
      ? searchAndScrape(String(body.query), { ...body, fetcher })
      : search(String(body.query), body);
  throw new Error("Not found");
}

export async function startServer(options: ServerOptions = {}): Promise<CrawlServer> {
  const token =
    options.token ?? process.env.BROWSER_CRAWL_TOKEN ?? randomBytes(24).toString("base64url");
  const jobs = new Jobs(options.deps ?? {});
  const fetcher = options.deps?.fetcher ?? new AutoFetcher();
  await pruneJobs(options.retentionDays ?? 7).catch(() => 0);
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (!authorized(request, token))
      return send(response, 401, { error: "Missing or wrong token" });
    const url = new URL(request.url ?? "/", "http://server");
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "v1") return send(response, 404, { error: "Not found" });
    if (parts[1] === "crawls") return send(response, 200, await listJobs());
    if (parts[1] === "crawl" && request.method === "POST" && !parts[2]) {
      const job = jobs.start((await readBody(request)) as CrawlOptions);
      return send(response, 201, { id: job.id, url: `/v1/crawl/${job.id}` });
    }
    if (parts[1] === "crawl") return jobRoute(jobs, request, response, url, parts);
    if (request.method === "POST" && parts[1])
      return send(response, 200, await actionRoute(parts[1], await readBody(request), fetcher));
    send(response, 404, { error: "Not found" });
  };
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) =>
      send(response, error instanceof Error && error.message === "Not found" ? 404 : 500, {
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const match = /^\/v1\/crawl\/([^/]+)\/ws/.exec(request.url ?? "");
    const job = match ? jobs.get(match[1] as string) : undefined;
    if (!job || !authorized(request, token)) return void socket.destroy();
    sockets.handleUpgrade(request, socket, head, (ws: WebSocket) => {
      const listener = (event: CrawlEvent) => ws.send(JSON.stringify(event));
      job.on("event", listener);
      ws.on("close", () => job.off("event", listener));
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", resolve),
  );
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://${options.host === "0.0.0.0" ? "127.0.0.1" : (options.host ?? "127.0.0.1")}:${port}`,
    token,
    close: async () => {
      sockets.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (!options.deps?.fetcher) await fetcher.close();
    },
  };
}
