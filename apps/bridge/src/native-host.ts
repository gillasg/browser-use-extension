import { BridgeClient, ensureBridge } from "./client.js";

// Chrome native messaging host. The extension sends one bootstrap message; the host makes sure
// the bridge is running and answers with its local endpoint and connection grant.
type Json = Record<string, unknown>;

export async function runNativeHost(): Promise<void> {
  const request = await readFrame();
  const version = request?.protocolVersion ?? { major: 1, minor: 6 };
  if (request?.kind === "model.status" || request?.kind === "model.login") {
    writeFrame(await modelRequest(String(request.kind)));
    return;
  }
  if (request?.kind !== "native.bootstrap") {
    writeFrame({
      kind: "native.bootstrap.result",
      protocolVersion: version,
      ok: false,
      code: "BOOTSTRAP_UNAVAILABLE",
    });
    return;
  }
  try {
    const state = await ensureBridge();
    writeFrame({
      kind: "native.bootstrap.result",
      protocolVersion: version,
      ok: true,
      endpoint: `ws://127.0.0.1:${state.port}/aeon/v1`,
      connectionGrant: state.token,
      expiresAt: Date.now() + 10 * 60_000,
      daemonProtocolVersion: version,
    });
  } catch {
    writeFrame({
      kind: "native.bootstrap.result",
      protocolVersion: version,
      ok: false,
      code: "DAEMON_OFFLINE",
    });
  }
}

/** The extension popup's "AI model" section: what is connected, and opening the sign-in page. */
async function modelRequest(kind: string): Promise<Json> {
  try {
    if (kind === "model.status") {
      const { modelStatus } = await import("./model-login.js");
      return { ok: true, ...(await modelStatus()) };
    }
    const bridge = await BridgeClient.connect();
    try {
      const reply = await bridge.request("model.login");
      return reply.url ? { ok: true, url: reply.url } : { ok: false, error: String(reply.error) };
    } finally {
      bridge.close();
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function readFrame(): Promise<Json | undefined> {
  return new Promise((resolve) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const length = buffer.readUInt32LE(0);
      if (buffer.length < 4 + length) return;
      process.stdin.off("data", onData);
      try {
        resolve(JSON.parse(buffer.subarray(4, 4 + length).toString("utf8")) as Json);
      } catch {
        resolve(undefined);
      }
    };
    process.stdin.on("data", onData);
    process.stdin.once("end", () => resolve(undefined));
  });
}

function writeFrame(message: Json): void {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}
