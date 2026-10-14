import { getModel, startLoginServer, status, type LoginServer } from "pi-ai-login";

// Signing in to AI models, for features that need one. Logins are shared with Pi and every
// app built on it, so a model connected anywhere on this computer works here too.
const IDLE_CLOSE_MS = 30 * 60_000;
let active: LoginServer | undefined;

/** Starts (or reuses) the sign-in page and returns its address. It closes once the user is done. */
export async function openModelLogin(): Promise<string> {
  if (active) return active.url;
  const server = await startLoginServer();
  active = server;
  const close = () => {
    if (active !== server) return;
    active = undefined;
    clearTimeout(timer);
    void server.close();
  };
  const timer = setTimeout(close, IDLE_CLOSE_MS);
  timer.unref();
  server.events.once("done", close).once("closed", close);
  return server.url;
}

export interface ModelStatus {
  connected: { id: string; name: string; type?: string }[];
  defaultModel: { provider: string; model: string } | null;
}

export async function modelStatus(): Promise<ModelStatus> {
  const state = await status();
  return {
    connected: state.providers
      .filter((provider) => provider.connected)
      .map((provider) => ({
        id: provider.id,
        name: provider.name,
        ...(provider.connection ? { type: provider.connection.type } : {}),
      })),
    defaultModel: state.defaultModel ?? null,
  };
}

/**
 * One completion with the user's default model, for another extension they allowed. Earlier
 * turns are folded into the request as a transcript, so any provider takes them.
 */
export async function modelComplete(
  system: string,
  messages: { role: string; content: string }[],
): Promise<string> {
  const handle = await getModel();
  const last = messages.at(-1)?.content ?? "";
  const earlier = messages
    .slice(0, -1)
    .map((message) => `${message.role === "assistant" ? "You" : "User"}: ${message.content}`)
    .join("\n\n");
  const content = earlier ? `Conversation so far:\n\n${earlier}\n\nNow:\n\n${last}` : last;
  const reply = await handle.models.completeSimple(handle.model, {
    systemPrompt: system,
    messages: [{ role: "user", content, timestamp: Date.now() }],
  });
  if (reply.stopReason === "error" || reply.stopReason === "aborted")
    throw new Error(
      `${handle.model.provider}/${handle.model.id}: ${reply.errorMessage ?? "the model failed"}`,
    );
  const text = reply.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
    .trim();
  if (!text) throw new Error(`${handle.model.provider}/${handle.model.id} returned no text`);
  return text;
}
