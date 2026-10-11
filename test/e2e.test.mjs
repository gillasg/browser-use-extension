// End to end: the built extension in real Chrome, the bridge, the CLI and the MCP server.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import WebSocket from "ws";

const chromePath =
  process.env.CHROME_PATH ??
  resolve("../aeon-browser/.slice0-audit/chrome-for-testing-154.0.8037.57/chrome-win64/chrome.exe");
const extension = resolve("apps/extension/build");
const cli = resolve("apps/bridge/dist/cli.js");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const run = promisify(execFile);

test(
  "agents drive real Chrome through the bridge, the CLI and MCP",
  { skip: !existsSync(chromePath) || !existsSync(extension) || !existsSync(cli) },
  async (t) => {
    const home = await mkdtemp(join(tmpdir(), "bue-home-"));
    const env = { ...process.env, BROWSER_USE_EXTENSION_HOME: home };
    const site = createServer((request, response) => {
      if (request.url?.startsWith("/api/language")) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ language: request.headers["accept-language"] }));
        return;
      }
      if (request.url?.startsWith("/api/items")) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ items: ["a", "b", "c"] }));
        return;
      }
      response.setHeader("content-type", "text/html");
      response.end(
        `<title>Shop</title><h1>Shop</h1><button onclick="document.title='bought'">Buy</button>`,
      );
    });
    await new Promise((done) => site.listen(0, "127.0.0.1", done));
    const siteUrl = `http://127.0.0.1:${site.address().port}/`;
    const bridge = spawn(process.execPath, [cli, "serve"], { env, stdio: "ignore" });
    const profile = await mkdtemp(join(tmpdir(), "bue-chrome-"));
    let chrome;
    try {
      const state = await waitFor(async () =>
        JSON.parse(await readFile(join(home, "bridge.json"), "utf8")),
      );

      await t.test("the native host answers the extension with the bridge endpoint", async () => {
        const reply = await nativeBootstrap(env);
        assert.equal(reply.ok, true);
        assert.equal(reply.endpoint, `ws://127.0.0.1:${state.port}/aeon/v1`);
        assert.equal(reply.connectionGrant, state.token);
      });

      chrome = spawn(
        chromePath,
        [
          `--user-data-dir=${profile}`,
          "--remote-debugging-port=0",
          `--load-extension=${extension}`,
          `--disable-extensions-except=${extension}`,
          "--no-first-run",
          "--no-default-browser-check",
          "--headless=new",
          "about:blank",
        ],
        { stdio: "ignore" },
      );
      const worker = await connectExtension(profile, env);

      await t.test("the CLI runs a cell that opens a tab and acts on it", async () => {
        const { stdout } = await run(
          process.execPath,
          [
            cli,
            "repl",
            `page = await browser.openTab(${JSON.stringify(siteUrl)}); const s = await bu.state(); await bu.click(/\\[(\\d+)\\] button "Buy"/.exec(s)[1]); await page.evaluate(() => document.title)`,
          ],
          { env },
        );
        assert.match(stdout, /button "Buy"/);
        assert.match(stdout, /→ bought/);
      });

      await t.test("the CLI session keeps its variables and tabs between calls", async () => {
        const { stdout } = await run(process.execPath, [cli, "repl", "page.url"], { env });
        assert.match(stdout, new RegExp("→ " + siteUrl.replaceAll(".", "\\.")));
      });

      await t.test("openTab makes the new tab current and bu.use takes a tab id", async () => {
        const { stdout } = await run(
          process.execPath,
          [
            cli,
            "repl",
            `const first = page.target.tabId; await browser.openTab(${JSON.stringify(siteUrl + "api/items")}); const opened = page.url; await bu.use(first); [opened.endsWith("/api/items"), page.target.tabId === first]`,
          ],
          { env },
        );
        assert.match(stdout, /→ \[\s*true,\s*true\s*\]/);
      });

      await t.test("agent tabs are grouped, and rules, history and bookmarks work", async () => {
        const cell = (code) =>
          run(process.execPath, [cli, "repl", "--session", "tools", code], { env });
        const opened = await cell(
          `page = await browser.openTab(${JSON.stringify(siteUrl)}); page.target.tabId`,
        );
        assert.match(opened.stdout, /→ \d+/, opened.stdout + opened.stderr);
        const tabId = Number(/→ (\d+)/.exec(opened.stdout)[1]);
        const grouped = await worker("Runtime.evaluate", {
          expression: `chrome.tabs.get(${tabId}).then(async (t) => t.groupId === -1 ? null : (await chrome.tabGroups.get(t.groupId)).title)`,
          awaitPromise: true,
          returnByValue: true,
        });
        assert.equal(grouped.result.result.value, "Agent");

        const { stdout } = await cell(`
          await page.rules.block({ urls: ["/api/items"] });
          await page.rules.mock("/api/mocked", { mocked: true });
          await page.rules.headers({ "Accept-Language": "hi-IN" });
          const blocked = await page.evaluate(() => fetch("/api/items").then(() => "loaded", () => "blocked"));
          const mocked = await page.evaluate(() => fetch("/api/mocked").then((r) => r.json()));
          const language = (await page.fetchJson("/api/language")).language;
          const rules = (await page.rules.list()).length;
          await page.rules.clear();
          const after = await page.evaluate(() => fetch("/api/items").then(() => "loaded", () => "blocked"));
          const visited = (await browser.history.search("Shop", { days: 1 })).length > 0;
          const mark = await browser.bookmarks.create({ title: "bue-test", url: ${JSON.stringify(siteUrl)} });
          const found = (await browser.bookmarks.search("bue-test")).length;
          await browser.bookmarks.remove(mark.id);
          console.log("RESULT " + JSON.stringify({ blocked, mocked, language, rules, after, visited, found }))`);
        assert.match(stdout, /RESULT /, stdout);
        assert.deepEqual(JSON.parse(/RESULT (.*)/.exec(stdout)[1]), {
          blocked: "blocked",
          mocked: { mocked: true },
          language: "hi-IN",
          rules: 3,
          after: "loaded",
          visited: true,
          found: 1,
        });
      });

      await t.test("MCP lists the tools and runs browser_code", async () => {
        const mcp = mcpClient(env);
        try {
          const init = await mcp.call("initialize", {
            protocolVersion: "2025-06-18",
            capabilities: {},
          });
          assert.equal(init.serverInfo.name, "browser-use-extension");
          const listed = await mcp.call("tools/list", {});
          assert.deepEqual(
            listed.tools.map((tool) => tool.name),
            ["browser_code", "browser_tabs"],
          );
          const called = await mcp.call("tools/call", {
            name: "browser_code",
            arguments: {
              code: `const p = await browser.openTab(${JSON.stringify(siteUrl)}); (await p.fetchJson('/api/items')).items.length`,
            },
          });
          assert.equal(called.isError, false, JSON.stringify(called));
          assert.match(called.content[0].text, /→ 3/);
          const tabs = await mcp.call("tools/call", { name: "browser_tabs", arguments: {} });
          assert.match(tabs.content[0].text, /127\.0\.0\.1/);
        } finally {
          mcp.close();
        }
      });

      await t.test("site skills saved by one agent are offered to another", async () => {
        await run(
          process.execPath,
          [
            cli,
            "repl",
            "--session",
            "one",
            `await skills.save({name: 'shop-buy', domains: ['127.0.0.1'], description: 'Buys the item', code: "var shop = {title: () => page.evaluate(() => document.title)}"})`,
          ],
          { env },
        );
        const { stdout } = await run(
          process.execPath,
          [
            cli,
            "repl",
            "--session",
            "two",
            `page = await browser.openTab(${JSON.stringify(siteUrl)}); await bu.state()`,
          ],
          { env },
        );
        assert.match(stdout, /Site skills .*shop-buy/);
      });
    } finally {
      chrome?.kill();
      bridge.kill();
      site.close();
      await sleep(300);
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
        () => {},
      );
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
        () => {},
      );
    }
  },
);

// Chrome only finds native hosts registered for the real browser, so the test answers the
// extension's bootstrap itself with what the native host returns.
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
    const ready = await cdp("Runtime.evaluate", {
      expression: "typeof chrome?.runtime?.id",
      returnByValue: true,
    });
    if (ready.result?.result?.value !== "string") throw new Error("worker not ready");
  });
  await cdp("Runtime.evaluate", {
    expression: `chrome.runtime.sendNativeMessage = (_host, request, callback) => callback(${JSON.stringify(reply)});`,
  });
  // Wake the connection: the extension retries on tab activation.
  const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json());
  const browser = await connect(version.webSocketDebuggerUrl);
  await browser("Target.createTarget", { url: "about:blank" });
  await waitFor(async () => {
    const { stdout } = await run(process.execPath, [cli, "status"], { env });
    if (!/1 browser/.test(stdout)) throw new Error(stdout);
  }, 30000);
  return cdp;
}

function nativeBootstrap(env) {
  return new Promise((resolveReply, reject) => {
    const host = spawn(
      process.execPath,
      [cli, "chrome-extension://dmlgohfphkbenjopdphcojgjeidlmajj/"],
      { env },
    );
    const chunks = [];
    host.stdout.on("data", (chunk) => chunks.push(chunk));
    host.on("error", reject);
    host.on("close", () => {
      const buffer = Buffer.concat(chunks);
      resolveReply(JSON.parse(buffer.subarray(4, 4 + buffer.readUInt32LE(0)).toString("utf8")));
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

function mcpClient(env) {
  const child = spawn(process.execPath, [cli, "mcp"], { env });
  let buffer = "";
  let id = 0;
  const waiting = new Map();
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      const message = JSON.parse(line);
      waiting.get(message.id)?.(message);
    }
  });
  return {
    call: (method, params) =>
      new Promise((done, fail) => {
        const my = ++id;
        waiting.set(my, (message) =>
          message.error ? fail(new Error(message.error.message)) : done(message.result),
        );
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: my, method, params }) + "\n");
      }),
    close: () => child.kill(),
  };
}

async function waitFor(check, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      return await check();
    } catch (error) {
      last = error;
      await sleep(150);
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
