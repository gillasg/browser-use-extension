import { AuthReplySchema } from "@browserkit/protocol";
export function authenticate(
  socket: WebSocket,
  hello: unknown,
): Promise<ReturnType<typeof AuthReplySchema.parse> | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (reply?: ReturnType<typeof AuthReplySchema.parse>) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      if (!reply || reply.kind !== "auth.ready") socket.close();
      resolve(reply);
    };
    const timer = globalThis.setTimeout(() => finish(), 5000);
    const onMessage = (event: MessageEvent) => {
      let value: unknown;
      try {
        value = JSON.parse(String(event.data)) as unknown;
      } catch {
        return finish();
      }
      const parsed = AuthReplySchema.safeParse(value);
      if (!parsed.success) return finish();
      finish(parsed.data);
    };
    socket.addEventListener("message", onMessage, { once: true });
    socket.addEventListener("open", () => socket.send(JSON.stringify(hello)), { once: true });
    socket.addEventListener("error", () => finish(), { once: true });
    socket.addEventListener("close", () => finish(), { once: true });
  });
}
