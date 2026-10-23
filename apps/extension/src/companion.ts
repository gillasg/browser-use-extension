// Other extensions sometimes ask whether this browser can provide an AI model. It cannot: agents
// bring their own model, so model requests are answered with a clear error instead of silence.

interface CompanionMessage {
  type?: string;
  kind?: string;
}

type Reply = { ok: true; value: unknown } | { ok: false; error: string };

const NO_MODEL =
  "No model available: Browser Use Extension does not provide an AI model. The agent using it supplies its own.";

function handle(message: CompanionMessage): Reply {
  if (message.kind === "ping")
    return { ok: true, value: { name: "Browser Use Extension", features: [] } };
  if (message.kind === "model.complete") return { ok: false, error: NO_MODEL };
  return { ok: false, error: `Unsupported request: ${String(message.kind)}` };
}

export function listenToCompanions(): void {
  chrome.runtime.onMessageExternal.addListener((message: CompanionMessage, sender, reply) => {
    if (message?.type !== "site-boosts" || !sender.id) return false;
    try {
      reply(handle(message));
    } catch (error) {
      reply({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  });
}
