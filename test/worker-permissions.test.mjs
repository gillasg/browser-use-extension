import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

// Loads the built service worker with only the Chrome APIs its manifest grants. An API the worker
// touches at load without the permission is undefined, as in Chrome, so the worker throws here
// instead of crashing in the user's browser with nothing in the browser answering.

const dist = new URL("../apps/extension/build/", import.meta.url);
// Namespaces every extension gets without asking for a permission.
const WEB_GLOBALS = [
  "clearTimeout",
  "clearInterval",
  "queueMicrotask",
  "structuredClone",
  "URL",
  "URLSearchParams",
  "TextEncoder",
  "TextDecoder",
  "AbortController",
  "AbortSignal",
  "crypto",
];
const ALWAYS = ["runtime", "tabs", "windows", "action", "i18n", "extension", "permissions"];

test("the service worker loads with only the permissions in its manifest", async () => {
  const manifest = JSON.parse(await readFile(new URL("manifest.json", dist), "utf8"));
  const source = await readFile(new URL("service-worker.js", dist), "utf8");
  const granted = new Set([...ALWAYS, ...manifest.permissions]);
  if (manifest.commands) granted.add("commands");
  const failures = [];
  const context = workerContext(manifest, granted, failures);
  try {
    vm.runInContext(source, context, { filename: "service-worker.js" });
  } catch (error) {
    failures.push("threw at load: " + describe(error) + " " + error.stack);
  }
  // Let the first microtasks run: installs that start right after load report here too.
  await new Promise((resolve) => setTimeout(resolve, 50));
  context.stopTimers();
  assert.deepEqual(failures, []);
});

function workerContext(manifest, granted, failures) {
  const timers = new Set();
  const chrome = {};
  for (const name of granted) chrome[name] = api(name);
  chrome.runtime = Object.assign(api("runtime"), {
    id: "bue-test",
    getURL: (path = "") => "chrome-extension://bue-test/" + String(path).replace(/^\//, ""),
    getManifest: () => manifest,
    lastError: undefined,
  });
  if (!granted.has("nativeMessaging")) delete chrome.runtime.connectNative;
  const console = {
    log() {},
    info() {},
    debug() {},
    warn() {},
    error: (...args) => failures.push("logged: " + args.map(describe).join(" ")),
  };
  const later =
    (set) =>
    (callback, ms, ...args) => {
      const timer = set(() => callback(...args), ms);
      timer.unref?.();
      timers.add(timer);
      return timer;
    };
  const context = {
    chrome,
    console,
    setTimeout: later(setTimeout),
    setInterval: later(globalThis.setInterval),
    ...Object.fromEntries(WEB_GLOBALS.map((name) => [name, globalThis[name]])),
    navigator: { userAgent: "Chrome/154", platform: "Win32", language: "en" },
    fetch: () => new Promise(() => undefined),
    WebSocket: class {
      constructor() {
        this.readyState = 0;
      }
      addEventListener() {}
      removeEventListener() {}
      send() {}
      close() {}
    },
    addEventListener() {},
    removeEventListener() {},
    location: { href: "chrome-extension://bue-test/service-worker.js" },
    stopTimers: () => timers.forEach((timer) => clearTimeout(timer)),
  };
  context.self = context;
  context.globalThis = context;
  return vm.createContext(context);
}

/** A stand-in Chrome API: events can be listened to, calls resolve, anything else nests. */
function api(path) {
  const target = function () {};
  return new Proxy(target, {
    get(target, key) {
      if (typeof key === "symbol") return undefined;
      if (Object.hasOwn(target, key)) return target[key];
      if (key === "then") return undefined;
      if (/^on[A-Z]/.test(key))
        return { addListener() {}, removeListener() {}, hasListener: () => false };
      if (/^[A-Z_]+$/.test(key)) return -1;
      return api(path + "." + key);
    },
    apply: () => new Promise(() => undefined),
  });
}

function describe(value) {
  if (value instanceof Error || (value && typeof value.message === "string")) {
    const inner = Array.isArray(value.errors)
      ? " (" + value.errors.map(describe).join("; ") + ")"
      : "";
    return value.message + inner;
  }
  return String(value);
}
