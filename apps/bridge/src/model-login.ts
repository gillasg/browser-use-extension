import { startLoginServer, status, type LoginServer } from "pi-ai-login";

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
