import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { dataDirectory, statePath, type BridgeState } from "./paths.js";
import { isSiteSkillRequest, siteSkillCall } from "./site-skills.js";
import { isWorkspaceRequest, validateUploadFiles, workspaceCall } from "./workspace.js";

// The bridge sits between the browser (extension executors) and agents (CLI and MCP clients).
// Agents send code cells; the bridge forwards each to a connected browser, serves the cell's
// workspace and site-skill calls, and returns the result.
type Json = Record<string, unknown>;
interface Target {
  clientInstanceId: string;
  browserRunId: string;
  tabId: number;
  tabIncarnation: string;
}
interface Executor {
  socket: WebSocket;
  clientInstanceId: string;
  tabs: Map<number, Json>;
}
interface Cell {
  executor: Executor;
  session: string;
  timeoutMs: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  progress: (message: Json) => void;
  finish: (result: Json) => void;
}

const PROTOCOL = { major: 1, minor: 6 };
const EXECUTOR_PATH = "/aeon/v1";

export class Bridge {
  private readonly executors = new Map<string, Executor>();
  private readonly cells = new Map<string, Cell>();
  /** Tabs each session opened, passed back as its targets on later cells. */
  private readonly sessionTargets = new Map<string, Map<string, Target>>();

  constructor(private readonly token: string) {}

  attach(socket: WebSocket, path: string): void {
    socket.once("message", (raw) => {
      const hello = parse(raw);
      if (path === EXECUTOR_PATH) this.acceptExecutor(socket, hello);
      else if (path === "/client") this.acceptClient(socket, hello);
      else socket.close(4404, "Unknown endpoint");
    });
  }

  tabs(): Json[] {
    return [...this.executors.values()].flatMap((executor) => [...executor.tabs.values()]);
  }

  async run(request: Json, onEvent: (event: Json) => void = () => undefined): Promise<Json> {
    const executor = await this.pickExecutor();
    if (!executor)
      return {
        error:
          "BROWSER_OFFLINE: open Chrome with Browser Use Extension installed (see `browser-use-extension setup`).",
      };
    const session = sessionId(String(request.session ?? "default"));
    const timeoutMs = Math.min(Math.max(Number(request.timeoutMs ?? 60000), 1000), 600000);
    const cellId = randomUUID();
    const targets = [...(this.sessionTargets.get(session)?.values() ?? [])].filter(
      (target) => target.clientInstanceId === executor.clientInstanceId,
    );
    return new Promise((resolve) => {
      this.cells.set(cellId, {
        executor,
        session,
        timeoutMs,
        timer: undefined,
        progress: (message) =>
          onEvent({
            event: "progress",
            steps: message.steps,
            ...(typeof message.waitingForUser === "boolean"
              ? { waitingForUser: message.waitingForUser }
              : {}),
          }),
        finish: resolve,
      });
      this.pause(cellId, false);
      send(executor.socket, {
        kind: "browser.code.run",
        cellId,
        chatId: session,
        toolCallId: String(request.id ?? cellId).slice(0, 256),
        code: String(request.code ?? ""),
        targets,
        timeoutMs,
      });
    });
  }

  private acceptExecutor(socket: WebSocket, hello: Json | undefined): void {
    if (hello?.kind !== "auth.hello" || hello.role !== "extension-executor") {
      socket.close(4001, "Malformed hello");
      return;
    }
    if (hello.connectionGrant !== this.token) {
      send(socket, {
        kind: "auth.rejected",
        protocolVersion: PROTOCOL,
        code: "AUTHENTICATION_FAILED",
      });
      socket.close(4003, "Authentication failed");
      return;
    }
    const executor: Executor = {
      socket,
      clientInstanceId: String(hello.clientInstanceId),
      tabs: new Map(),
    };
    this.executors.get(executor.clientInstanceId)?.socket.close(4000, "Replaced");
    this.executors.set(executor.clientInstanceId, executor);
    send(socket, {
      kind: "auth.ready",
      protocolVersion: PROTOCOL,
      role: "extension-executor",
      connectionId: randomUUID(),
    });
    socket.on("message", (raw) => this.onExecutorMessage(executor, parse(raw)));
    socket.on("close", () => this.dropExecutor(executor));
  }

  private dropExecutor(executor: Executor): void {
    if (this.executors.get(executor.clientInstanceId) === executor)
      this.executors.delete(executor.clientInstanceId);
    for (const [cellId, cell] of this.cells)
      if (cell.executor === executor)
        this.end(cellId, { error: "BROWSER_OFFLINE: the browser disconnected" });
  }

  private onExecutorMessage(executor: Executor, message: Json | undefined): void {
    if (!message) return;
    if (message.kind === "browser.inventory.full" || message.kind === "browser.inventory.delta") {
      this.applyInventory(executor, message);
    } else if (message.kind === "browser.executor.heartbeat") {
      send(executor.socket, {
        kind: "browser.executor.heartbeat.ack",
        clientInstanceId: message.clientInstanceId,
        browserRunId: message.browserRunId,
      });
    } else if (message.kind === "browser.code.call") {
      void this.serveCall(executor, message);
    } else if (message.kind === "browser.code.progress") {
      const cell = this.cells.get(String(message.cellId));
      if (typeof message.waitingForUser === "boolean")
        this.pause(String(message.cellId), message.waitingForUser);
      cell?.progress(message);
    } else if (message.kind === "browser.code.result") {
      this.complete(message);
    }
  }

  private applyInventory(executor: Executor, message: Json): void {
    if (message.kind === "browser.inventory.full")
      executor.tabs = new Map((message.tabs as Json[]).map((tab) => [tabIdOf(tab), tab]));
    else {
      const delta = message.delta as Json;
      if (delta.kind === "tab.upsert")
        executor.tabs.set(tabIdOf(delta.tab as Json), delta.tab as Json);
      else if (delta.kind === "tab.remove")
        executor.tabs.delete(Number((delta.target as Json | undefined)?.tabId));
    }
    send(executor.socket, {
      kind: "browser.inventory.applied",
      generation: message.generation,
      lastSequence: message.kind === "browser.inventory.full" ? 0 : message.sequence,
    });
  }

  private complete(message: Json): void {
    const cellId = String(message.cellId);
    const cell = this.cells.get(cellId);
    if (!cell) return;
    for (const target of (message.opened as Target[] | undefined) ?? [])
      this.remember(cell.session, target);
    this.end(cellId, message);
  }

  private async serveCall(executor: Executor, message: Json): Promise<void> {
    const reply = (body: Json) =>
      send(executor.socket, {
        kind: "browser.code.reply",
        cellId: message.cellId,
        callId: message.callId,
        ...body,
      });
    try {
      const cell = this.cells.get(String(message.cellId));
      if (!cell) throw new Error("Browser cell is no longer active");
      reply({ value: await serveRequest(message.request, cell.session) });
    } catch (error) {
      reply({ error: (error instanceof Error ? error.message : String(error)).slice(0, 20000) });
    }
  }

  private acceptClient(socket: WebSocket, hello: Json | undefined): void {
    if (hello?.kind !== "hello" || hello.token !== this.token) {
      socket.close(4003, "Authentication failed");
      return;
    }
    send(socket, { kind: "ready" });
    socket.on("message", (raw) => {
      const request = parse(raw);
      if (!request) return;
      const respond = (body: Json) => send(socket, { id: request.id, ...body });
      if (request.kind === "status") respond({ browsers: this.executors.size });
      else if (request.kind === "tabs") respond({ tabs: this.tabs() });
      else if (request.kind === "model.login")
        // Loaded on first use: the model providers are only needed for signing in.
        void import("./model-login.js")
          .then(({ openModelLogin }) => openModelLogin())
          .then(
            (url) => respond({ url }),
            (error: unknown) => respond({ error: String(error) }),
          );
      else if (request.kind === "run")
        void this.run(request, (event) => send(socket, { id: request.id, ...event })).then(respond);
      else respond({ error: "Unknown request" });
    });
  }

  /** A cell's deadline stops while the user handles a hand-off and restarts in full after. */
  private pause(cellId: string, waiting: boolean): void {
    const cell = this.cells.get(cellId);
    if (!cell) return;
    if (cell.timer) clearTimeout(cell.timer);
    cell.timer = waiting
      ? undefined
      : setTimeout(() => {
          send(cell.executor.socket, { kind: "browser.code.cancel", cellId, reset: true });
          this.end(cellId, { error: "Browser code exceeded its deadline; runtime reset" });
        }, cell.timeoutMs + 5000);
  }

  private end(cellId: string, result: Json): void {
    const cell = this.cells.get(cellId);
    if (!cell) return;
    this.cells.delete(cellId);
    if (cell.timer) clearTimeout(cell.timer);
    cell.finish(result);
  }

  private remember(session: string, target: Target): void {
    const targets = this.sessionTargets.get(session) ?? new Map<string, Target>();
    targets.set(`${target.clientInstanceId}:${target.tabId}:${target.tabIncarnation}`, target);
    this.sessionTargets.set(session, targets);
  }

  /** A freshly started bridge gives the extension a few seconds to (re)connect. */
  private async pickExecutor(): Promise<Executor | undefined> {
    for (let waited = 0; waited <= 8000; waited += 250) {
      const open = [...this.executors.values()].find(
        (item) => item.socket.readyState === WebSocket.OPEN,
      );
      if (open) return open;
      await new Promise((done) => setTimeout(done, 250));
    }
    return undefined;
  }
}

/** Workspace files, site skills and upload checks: what a cell asks of the machine. */
function serveRequest(request: unknown, session: string): Promise<unknown> {
  const workspace = join(dataDirectory(), "workspaces", session);
  if (isSiteSkillRequest(request))
    return siteSkillCall(join(dataDirectory(), "site-skills"), request);
  if (isWorkspaceRequest(request)) return workspaceCall(workspace, request);
  const upload = request as { validateUpload?: unknown } | null;
  if (Array.isArray(upload?.validateUpload))
    return validateUploadFiles(upload.validateUpload as string[], workspace);
  return Promise.reject(new Error("UNSUPPORTED: unknown browser runtime request"));
}

function tabIdOf(tab: Json): number {
  return Number((tab.target as Json | undefined)?.tabId);
}

/** Session names map to stable UUIDs: the extension keys REPL realms and tab ownership by them. */
export function sessionId(name: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(name))
    return name;
  const hex = createHash("sha256")
    .update("session:" + name)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function parse(raw: RawData): Json | undefined {
  try {
    const value = JSON.parse(String(raw)) as unknown;
    return typeof value === "object" && value !== null ? (value as Json) : undefined;
  } catch {
    return undefined;
  }
}

function send(socket: WebSocket, message: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

/** Starts the bridge on a free local port and publishes its port and token. */
export async function startBridge(
  port = 0,
): Promise<{ bridge: Bridge; state: BridgeState; close(): void }> {
  const token = randomBytes(32).toString("base64url");
  const bridge = new Bridge(token);
  const server = new WebSocketServer({ host: "127.0.0.1", port, maxPayload: 32 * 1024 * 1024 });
  server.on("connection", (socket, request) =>
    bridge.attach(socket, (request.url ?? "").split("?")[0] ?? ""),
  );
  await new Promise<void>((done) => server.once("listening", () => done()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Bridge could not listen");
  const state: BridgeState = { port: address.port, token, pid: process.pid };
  await mkdir(dataDirectory(), { recursive: true });
  const temporary = statePath() + "." + process.pid + ".tmp";
  await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
  await rename(temporary, statePath());
  return { bridge, state, close: () => server.close() };
}
