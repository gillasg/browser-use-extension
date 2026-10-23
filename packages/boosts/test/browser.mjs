// Runs the built extension in a private, headless Chrome for Testing and drives it over CDP.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

export const chromePath = process.env.CHROME_PATH ?? "";
export const extensionDir = fileURLToPath(new URL("../build/", import.meta.url));
export const EXTENSION_ID = "kcfodpkdfapojnbhkgdlpkikipneejpf";
export const canRun =
  Boolean(chromePath) && existsSync(chromePath) && existsSync(join(extensionDir, "manifest.json"));

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export async function waitFor(check, timeoutMs = 15000, label = "condition") {
  const end = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      const value = await check();
      if (value !== undefined && value !== false && value !== null) return value;
    } catch (error) {
      last = error;
    }
    if (Date.now() > end)
      throw new Error(`Timed out waiting for ${label}${last ? `: ${last.message}` : ""}`);
    await sleep(150);
  }
}

function connect(url, onEvent = () => undefined) {
  return new Promise((done, fail) => {
    const socket = new WebSocket(url, { perMessageDeflate: false });
    let id = 0;
    const pending = new Map();
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (message.method) onEvent(message.method, message.params);
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    });
    socket.on("error", fail);
    socket.on("open", () =>
      done({
        call: (method, params = {}) =>
          new Promise((reply) => {
            pending.set(++id, reply);
            socket.send(JSON.stringify({ id, method, params }));
          }),
        close: () => socket.close(),
      }),
    );
  });
}

/** A page (or extension page) target with evaluate(). */
async function attach(port, targetId) {
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
  const target = targets.find((t) => t.id === targetId);
  // Uncaught errors in the page, so tests can check a page ran cleanly.
  const errors = [];
  const cdp = await connect(target.webSocketDebuggerUrl, (method, params) => {
    if (method === "Runtime.exceptionThrown")
      errors.push(params.exceptionDetails.exception?.description ?? params.exceptionDetails.text);
  });
  await cdp.call("Runtime.enable");
  const evaluate = async (expression) => {
    const { result, error } = await cdp.call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (error) throw new Error(error.message);
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
      );
    return result.result.value;
  };
  return {
    id: targetId,
    cdp,
    errors,
    evaluate,
    async navigate(url) {
      await cdp.call("Page.enable");
      await cdp.call("Page.navigate", { url });
      await waitFor(
        async () =>
          (await evaluate("document.readyState")) === "complete" &&
          (await evaluate("location.href")).startsWith(url.split("#")[0]),
        15000,
        `loading ${url}`,
      );
    },
    async url() {
      return evaluate("location.href");
    },
    close: () => cdp.close(),
  };
}

export async function launch() {
  const profile = await mkdtemp(join(tmpdir(), "site-boosts-chrome-"));
  const chrome = spawn(
    chromePath,
    [
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
      `--load-extension=${extensionDir}`,
      `--disable-extensions-except=${extensionDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      ...(process.env.SHOW_CHROME ? ["--window-position=-32000,-32000"] : ["--headless=new"]),
      "--window-size=1280,900",
      ...(process.platform === "linux" && process.env.CI ? ["--no-sandbox"] : []),
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const port = await waitFor(
    async () =>
      Number((await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]),
    20000,
    "Chrome",
  );
  const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json());
  const browser = await connect(version.webSocketDebuggerUrl);
  await waitFor(
    async () => {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      return targets.some((t) =>
        t.url.startsWith(`chrome-extension://${EXTENSION_ID}/background.js`),
      );
    },
    20000,
    "the extension's service worker",
  );

  async function open(url, options = {}) {
    const { result } = await browser.call("Target.createTarget", {
      url: "about:blank",
      newWindow: Boolean(options.window),
    });
    const page = await attach(port, result.targetId);
    if (url) await page.navigate(url);
    return page;
  }

  // Chrome keeps extension scripts off until "Allow User Scripts" is on; switch it on as a person would.
  const settings = await open("chrome://extensions");
  await settings.evaluate(
    `chrome.developerPrivate.updateExtensionConfiguration({ extensionId: "${EXTENSION_ID}", userScriptsAccess: true })`,
  );
  await settings.close();

  const manager = await open(`chrome-extension://${EXTENSION_ID}/manager.html`);
  const ext = async (kind, data = {}) => {
    const reply = await manager.evaluate(
      `chrome.runtime.sendMessage(${JSON.stringify({ kind, ...data })})`,
    );
    if (!reply?.ok) throw new Error(reply?.error ?? `no reply to ${kind}`);
    return reply.value;
  };
  await waitFor(async () => (await ext("status")).userScripts, 10000, "user scripts to be allowed");

  return {
    open,
    ext,
    manager,
    /** The Chrome tab id of a page target. */
    async tabId(page) {
      const url = await page.url();
      const tabs = await manager.evaluate(
        `chrome.tabs.query({}).then((tabs) => tabs.map((t) => ({ id: t.id, url: t.url })))`,
      );
      return tabs.filter((t) => t.url === url).sort((a, b) => b.id - a.id)[0]?.id;
    },
    async close() {
      browser.close();
      chrome.kill();
      await new Promise((done) => chrome.once("exit", done).once("error", done));
      await rm(profile, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
