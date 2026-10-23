// A private, headless Chrome for Testing with browserkit and its own bridge, for
// end-to-end tests. Nothing touches the user's browser or real data.
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import WebSocket from "ws";

const run = promisify(execFile);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const bue = resolve(process.env.BUE_DIR ?? "../..");
const extension = join(bue, "apps/extension/build");
const bueCli = join(bue, "apps/bridge/dist/cli.js");
const chromePath = process.env.CHROME_PATH ?? "";

export const browserReady =
  !!chromePath && existsSync(chromePath) && existsSync(extension) && existsSync(bueCli);

export async function launchBrowser(t) {
  const home = await mkdtemp(join(tmpdir(), "crawl-e2e-"));
  const profile = await mkdtemp(join(tmpdir(), "crawl-chrome-"));
  const env = {
    ...process.env,
    BROWSER_USE_EXTENSION_HOME: home,
    SITE_TO_API_HOME: home,
    BROWSER_CRAWL_HOME: home,
  };
  Object.assign(process.env, {
    BROWSER_USE_EXTENSION_HOME: home,
    SITE_TO_API_HOME: home,
    BROWSER_CRAWL_HOME: home,
  });
  const bridge = spawn(process.execPath, [bueCli, "serve"], { env, stdio: "ignore" });
  let chrome;
  t.after(async () => {
    const { closeSharedBridge } = await import("../dist/bridge.js");
    await closeSharedBridge();
    chrome?.kill();
    bridge.kill();
    await sleep(500);
    for (const dir of [home, profile])
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  await waitFor(() => readFile(join(home, "bridge.json"), "utf8"));
  const args = [
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    `--load-extension=${extension}`,
    `--disable-extensions-except=${extension}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--headless=new",
  ];
  if (process.platform === "linux" && process.env.CI) args.push("--no-sandbox");
  chrome = spawn(chromePath, [...args, "about:blank"], { stdio: "ignore" });
  await connectExtension(profile, env);
  return env;
}

async function connectExtension(profile, env) {
  const port = await waitFor(async () =>
    Number((await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]),
  );
  const worker = await waitFor(async () => {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
    const found = targets.find((item) => item.url.endsWith("/service-worker.js"));
    if (!found) throw new Error("no worker yet");
    return found;
  });
  const reply = await nativeBootstrap(env);
  const cdp = await connect(worker.webSocketDebuggerUrl);
  await waitFor(async () => {
    const value = await cdp("Runtime.evaluate", {
      expression: "typeof chrome?.runtime?.id",
      returnByValue: true,
    });
    if (value.result?.result?.value !== "string") throw new Error("worker not ready");
  });
  await cdp("Runtime.evaluate", {
    expression: `chrome.runtime.sendNativeMessage = (_host, request, callback) => callback(${JSON.stringify(reply)});`,
  });
  const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json());
  const browser = await connect(version.webSocketDebuggerUrl);
  await browser("Target.createTarget", { url: "about:blank" });
  await waitFor(async () => {
    const { stdout } = await run(process.execPath, [bueCli, "status"], { env });
    if (!/1 browser/.test(stdout)) throw new Error(stdout);
  }, 30_000);
}

function nativeBootstrap(env) {
  return new Promise((done, fail) => {
    const host = spawn(
      process.execPath,
      [bueCli, "chrome-extension://dmlgohfphkbenjopdphcojgjeidlmajj/"],
      { env },
    );
    const chunks = [];
    host.stdout.on("data", (chunk) => chunks.push(chunk));
    host.on("error", fail);
    host.on("close", () => {
      const buffer = Buffer.concat(chunks);
      done(JSON.parse(buffer.subarray(4, 4 + buffer.readUInt32LE(0)).toString("utf8")));
    });
    const body = Buffer.from(
      JSON.stringify({
        kind: "native.bootstrap",
        protocolVersion: { major: 1, minor: 6 },
        clientInstanceId: "091b9308-1ee9-420e-b71f-a564a5a27701",
        browserRunId: "3ee7ba6e-5aad-4692-9e4e-fb4cff0964f8",
      }),
    );
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length);
    host.stdin.end(Buffer.concat([header, body]));
  });
}

async function waitFor(check, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      return await check();
    } catch (error) {
      last = error;
      await sleep(200);
    }
  }
  throw last ?? new Error("timed out");
}

function connect(url) {
  const socket = new WebSocket(url);
  let id = 0;
  const waiting = new Map();
  socket.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
  });
  const opened = new Promise((done) => socket.once("open", done));
  return async (method, params = {}) => {
    await opened;
    return new Promise((done) => {
      waiting.set(++id, done);
      socket.send(JSON.stringify({ id, method, params }));
    });
  };
}
