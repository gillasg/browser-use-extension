// How a running script reaches the service worker.
// - Isolated world: its own long-lived port (userScripts messaging).
// - Page world: DOM events to a small bridge in the isolated world, which owns the port.

export type Push = (event: string, data: unknown) => void;

export interface Transport {
  call(op: string, args?: unknown): Promise<unknown>;
  /** Starts a streaming operation; events arrive until "done". Returns a way to cancel it. */
  stream(op: string, args: unknown, onEvent: (event: string, data: unknown) => void): () => void;
  onPush(handler: Push): void;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  onEvent?: (event: string, data: unknown) => void;
}

type Wire =
  | { t: "call"; id: number; op: string; args: unknown; stream?: boolean }
  | { t: "cancel"; id: number }
  | { t: "reply"; id: number; value?: unknown; error?: string }
  | { t: "event"; id: number; event: string; data: unknown }
  | { t: "push"; event: string; data: unknown }
  | { t: "hello" }
  | { t: "ready" };

/** The request bookkeeping both transports share; `post` sends one message up. */
function protocol(post: (message: Wire) => void): Transport & { receive(message: Wire): void } {
  let next = 1;
  const pending = new Map<number, Pending>();
  const pushes: Push[] = [];
  return {
    call(op, args) {
      return new Promise((resolve, reject) => {
        const id = next++;
        pending.set(id, { resolve, reject });
        post({ t: "call", id, op, args });
      });
    },
    stream(op, args, onEvent) {
      const id = next++;
      pending.set(id, { resolve: () => undefined, reject: () => undefined, onEvent });
      post({ t: "call", id, op, args, stream: true });
      return () => {
        pending.delete(id);
        post({ t: "cancel", id });
      };
    },
    onPush(handler) {
      pushes.push(handler);
    },
    receive(message) {
      if (message.t === "push") for (const handler of pushes) handler(message.event, message.data);
      if (message.t !== "reply" && message.t !== "event") return;
      const entry = pending.get(message.id);
      if (!entry) return;
      if (message.t === "event") {
        entry.onEvent?.(message.event, message.data);
        if (message.event === "done") pending.delete(message.id);
        return;
      }
      pending.delete(message.id);
      if (message.error !== undefined) entry.reject(new Error(message.error));
      else entry.resolve(message.value);
    },
  };
}

/** Isolated world: talk to the service worker over a port, reconnecting after it sleeps. */
export function portTransport(name: string): Transport {
  let port: chrome.runtime.Port | undefined;
  const wire = protocol((message) => connect().postMessage(message));
  function connect(): chrome.runtime.Port {
    if (port) return port;
    const opened = chrome.runtime.connect({ name });
    opened.onMessage.addListener((message: Wire) => wire.receive(message));
    opened.onDisconnect.addListener(() => {
      if (port === opened) port = undefined;
    });
    port = opened;
    return opened;
  }
  connect();
  return wire;
}

const up = (nonce: string): string => `sb-${nonce}-up`;
const down = (nonce: string): string => `sb-${nonce}-down`;

/** Page world: messages go through DOM events to the bridge. Queued until the bridge is ready. */
export function eventTransport(nonce: string): Transport {
  let ready = false;
  const queue: Wire[] = [];
  const emit = (message: Wire): void => {
    document.dispatchEvent(new CustomEvent(up(nonce), { detail: JSON.stringify(message) }));
  };
  const wire = protocol((message) => (ready ? emit(message) : queue.push(message)));
  document.addEventListener(down(nonce), (event) => {
    const message = JSON.parse(String((event as CustomEvent).detail)) as Wire;
    if (message.t === "ready") {
      if (ready) return;
      ready = true;
      for (const queued of queue.splice(0)) emit(queued);
      return;
    }
    wire.receive(message);
  });
  emit({ t: "hello" });
  return wire;
}

/** The isolated-world half of the page-world transport. */
export function startBridge(nonce: string, name: string): void {
  let port: chrome.runtime.Port | undefined;
  const toPage = (message: Wire): void => {
    document.dispatchEvent(new CustomEvent(down(nonce), { detail: JSON.stringify(message) }));
  };
  function connect(): chrome.runtime.Port {
    if (port) return port;
    const opened = chrome.runtime.connect({ name });
    opened.onMessage.addListener((message: Wire) => toPage(message));
    opened.onDisconnect.addListener(() => {
      if (port === opened) port = undefined;
    });
    port = opened;
    return opened;
  }
  document.addEventListener(up(nonce), (event) => {
    const message = JSON.parse(String((event as CustomEvent).detail)) as Wire;
    if (message.t === "hello") toPage({ t: "ready" });
    else connect().postMessage(message);
  });
  connect();
  toPage({ t: "ready" });
}
