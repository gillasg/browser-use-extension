// Hosts one sandboxed realm per chat and relays its browser calls to the service worker.
interface Realm {
  frame: HTMLIFrameElement;
  ready: Promise<void>;
}
const realms = new Map<string, Realm>();
const cells = new Map<string, { chatId: string; reply: (value: unknown) => void }>();

function realm(chatId: string): Realm {
  const existing = realms.get(chatId);
  if (existing) return existing;
  const frame = document.createElement("iframe");
  frame.src = "code-sandbox.html";
  const ready = new Promise<void>((resolve) =>
    frame.addEventListener("load", () => resolve(), { once: true }),
  );
  document.body.append(frame);
  const created = { frame, ready };
  realms.set(chatId, created);
  return created;
}

function drop(chatId: string): void {
  realms.get(chatId)?.frame.remove();
  realms.delete(chatId);
  for (const [cellId, cell] of cells)
    if (cell.chatId === chatId) {
      cells.delete(cellId);
      cell.reply({ output: "", error: "Browser runtime reset", reset: true });
    }
}

window.addEventListener("message", (event) => {
  const message = event.data as {
    kind?: string;
    cellId?: string;
    callId?: string;
    request?: unknown;
  };
  const source = [...realms.entries()].find(
    ([, item]) => item.frame.contentWindow === event.source,
  );
  if (!source || typeof message?.cellId !== "string") return;
  const [chatId, item] = source;
  if (message.kind === "call") {
    void chrome.runtime
      .sendMessage({
        target: "aeon-code-host",
        kind: "call",
        cellId: message.cellId,
        request: message.request,
      })
      .then(
        (response: { value?: unknown; error?: string } | undefined) =>
          response ?? { error: "Browser host unavailable" },
        (error: unknown) => ({ error: String(error) }),
      )
      .then((response) =>
        item.frame.contentWindow?.postMessage(
          { kind: "reply", callId: message.callId, ...response },
          "*",
        ),
      );
    return;
  }
  if (message.kind === "done") {
    const cell = cells.get(message.cellId);
    if (!cell || cell.chatId !== chatId) return;
    cells.delete(message.cellId);
    const done = message as Record<string, unknown>;
    cell.reply({ value: done.value, output: done.output, error: done.error });
  }
});

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.target !== "aeon-code-offscreen" || sender.id !== chrome.runtime.id) return;
  if (message.kind === "reset") {
    drop(message.chatId);
    reply(true);
    return;
  }
  if (message.kind !== "cell") return;
  const target = realm(message.chatId);
  cells.set(message.cellId, { chatId: message.chatId, reply });
  void target.ready.then(() =>
    target.frame.contentWindow?.postMessage(
      { kind: "cell", cellId: message.cellId, code: message.code, attached: message.attached },
      "*",
    ),
  );
  return true;
});
