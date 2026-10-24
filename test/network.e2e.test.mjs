// End to end: network waiting and always-on capture, a tab whose page fails, embedded-data
// search, referer/origin on browser.fetch, classified fetch errors and the per-session run log.
// Its own Chrome and fixture site, so it runs alone: node --test test/network.e2e.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import WebSocket from "ws";
import { networkRoutes, ORIGIN, REFERER } from "./network-site.mjs";

const chromePath =
  process.env.CHROME_PATH ??
  resolve("../aeon-browser/.slice0-audit/chrome-for-testing-154.0.8037.57/chrome-win64/chrome.exe");
const extension = resolve("apps/extension/build");
const cli = resolve("apps/bridge/dist/cli.js");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const run = promisify(execFile);

test(
  "network waiting, failed tabs, page data search and fetch classification",
  {
    skip:
      !process.env.REQUIRE_E2E &&
      (!existsSync(chromePath) || !existsSync(extension) || !existsSync(cli)),
  },
  async (t) => {
    const home = await mkdtemp(join(tmpdir(), "bue-net-"));
    const env = {
      ...process.env,
      BROWSERKIT_HOME: home,
      SITE_TO_API_HOME: join(home, "site-to-api"),
    };
    const site = createServer((request, response) => {
      if (networkRoutes(request, response)) return;
      response.statusCode = 404;
      response.setHeader("content-type", "text/html");
      response.end("<title>Not found</title>Not found");
    });
    await new Promise((done) => site.listen(0, "127.0.0.1", done));
    const base = `http://127.0.0.1:${site.address().port}/`;
    // A port nothing listens on: refused connections and failed navigations.
    const closed = await closedPort();
    const bridge = spawn(process.execPath, [cli, "serve"], { env, stdio: "ignore" });
    const profile = await mkdtemp(join(tmpdir(), "bue-net-chrome-"));
    const repl = async (code) => {
      const result = await run(process.execPath, [cli, "repl", "--session", "net", code], {
        env,
      }).catch((error) => error);
      return String(result.stdout ?? "") + String(result.stderr ?? "");
    };
    let chrome;
    try {
      await waitFor(async () => JSON.parse(await readFile(join(home, "bridge.json"), "utf8")));
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
          ...(process.platform === "linux" && process.env.CI ? ["--no-sandbox"] : []),
          "about:blank",
        ],
        { stdio: "ignore" },
      );
      await connectExtension(profile, env);

      await t.test("a tab is recorded from its first request, without start()", async () => {
        const out = await repl(
          `page = await browser.openTab(${JSON.stringify(base + "slow")});
          var listed = await page.network.list();
          console.log('RESULT ' + JSON.stringify(listed.map((r) => ({url: r.url, type: r.type, status: r.status}))));`,
        );
        const listed = json(out);
        assert.ok(
          listed.some((entry) => entry.url.endsWith("/api/load") && entry.status === 200),
          out,
        );
      });

      await t.test("an empty list says why instead of returning a bare []", async () => {
        const out = await repl(
          `var other = await browser.openTab(${JSON.stringify(base + "plain")}, {newTab: true});
          var empty = await other.network.list({match: '/api/'});
          console.log('RESULT ' + JSON.stringify({empty: empty.length, note: empty.note || null}));`,
        );
        const listed = json(out);
        assert.equal(listed.empty, 0, out);
        assert.match(String(listed.note), /no request matches/, out);
        assert.match(out, /captured: GET http:\/\/127\.0\.0\.1:\d+\/plain 200/, out);
      });
      await t.test("waitFor resolves with the call a click caused", async () => {
        const out = await repl(
          `page = await browser.openTab(${JSON.stringify(base + "slow")});
          var waiting = page.network.waitFor({match: '/api/slow', timeoutMs: 15000});
          await page.getByRole('button', {name: 'Load'}).click();
          var hit = await waiting;
          console.log('RESULT ' + JSON.stringify({url: hit.url, status: hit.status, body: hit.body, headers: hit.headers}));`,
        );
        const hit = json(out);
        assert.equal(hit.status, 200, out);
        assert.match(hit.url, /\/api\/slow\?from=click/, out);
        assert.equal(hit.body.json.item.title, "Slow", out);
        assert.match(String(hit.headers["content-type"]), /application\/json/, out);
      });
      await t.test(
        "waitFor filters on method and status, and names the pattern on timeout",
        async () => {
          const pattern = await repl(
            `var failure = await page.network.waitFor({match: '/api/never', timeoutMs: 500}).then(() => 'none', (e) => e.message);
          var byStatus = await page.network.waitFor({match: '/api/slow', status: '4xx', timeoutMs: 500}).then(() => 'none', (e) => e.message);
          console.log('RESULT ' + JSON.stringify({pattern: failure, byStatus}));`,
          );
          const missed = json(pattern);
          assert.match(
            missed.pattern,
            /TIMEOUT: no request matching "\/api\/never" completed within 500 ms/,
            pattern,
          );
          assert.match(missed.byStatus, /status 4xx/, pattern);
        },
      );

      await t.test("a tab whose page fails is returned, not thrown away", async () => {
        const out = await repl(
          `var dead = await browser.openTab(${JSON.stringify(`http://127.0.0.1:${closed}/x`)}, {newTab: true});
          var listed = (await browser.tabs()).find((tab) => tab.id === dead.id);
          console.log('RESULT ' + JSON.stringify({id: dead.id, navigation: dead.navigation, reason: dead.reason, mine: listed && listed.mine}));`,
        );
        const dead = json(out);
        assert.equal(typeof dead.id, "number", out);
        assert.equal(dead.navigation, "failed", out);
        assert.match(String(dead.reason), /ERR_CONNECTION_REFUSED|OPERATION_FAILED|failed/i, out);
        assert.equal(dead.mine, true, out);
      });

      await t.test("page.data({find}) returns the arrays that hold the keys", async () => {
        const out = await repl(
          `page = await browser.openTab(${JSON.stringify(base + "next")});
          var found = await page.data({find: ['title', 'id']});
          var summary = await page.data();
          console.log('RESULT ' + JSON.stringify({find: found.find, lists: found.lists, plainLists: summary.lists}));`,
        );
        const found = json(out);
        const items = found.lists.find((list) => /items$/.test(list.path));
        assert.ok(items, out);
        assert.equal(items.count, 3, out);
        assert.equal(items.items[0].title, "Lamp", out);
        const rows = found.lists.find((list) => /rows$/.test(list.path));
        assert.ok(rows, out);
        assert.equal(rows.count, 1, out);
        assert.ok(found.plainLists?.length, out);
      });

      await t.test("browser.fetch sends Referer and Origin for the one request", async () => {
        const out = await repl(
          `var refused = await browser.fetch(${JSON.stringify(base + "api/referer")}).then((r) => ({status: r.status}), (e) => ({error: e.message}));
          var sent = await browser.fetch(${JSON.stringify(base + "api/referer")}, {headers: {referer: ${JSON.stringify(REFERER)}, origin: ${JSON.stringify(ORIGIN)}}});
          console.log('RESULT ' + JSON.stringify({refused: refused.status, echo: sent.json}));`,
        );
        const fetched = json(out);
        assert.equal(fetched.refused, 403, out);
        assert.equal(fetched.echo.referer, REFERER, out);
        assert.equal(fetched.echo.origin, ORIGIN, out);
      });

      await t.test("a failed fetch names its kind, host and a readable reason", async () => {
        const out = await repl(
          `var attempt = (url, options) => browser.fetch(url, options).then(() => ({ok: true}), (e) => ({message: e.message, kind: e.kind, host: e.host}));
          var dns = await attempt('http://no-such-host.invalid/');
          var refused = await attempt(${JSON.stringify(`http://127.0.0.1:${closed}/`)});
          var timeout = await attempt(${JSON.stringify(base + "stall")}, {timeoutMs: 1000});
          console.log('RESULT ' + JSON.stringify({dns, refused, timeout}));`,
        );
        const failed = json(out);
        assert.equal(failed.dns.kind, "dns", out);
        assert.equal(failed.dns.host, "no-such-host.invalid", out);
        assert.match(failed.dns.message, /DNS lookup failed for no-such-host\.invalid/, out);
        assert.equal(failed.refused.kind, "refused", out);
        assert.match(failed.refused.message, /connection refused by 127\.0\.0\.1/, out);
        assert.equal(failed.timeout.kind, "timeout", out);
        assert.match(failed.timeout.message, /no answer from 127\.0\.0\.1 in time/, out);
      });

      await t.test("the bridge writes one run log per session", async () => {
        const runs = await findRunLogs(join(home, "sessions"));
        assert.ok(runs.length, "no run log written");
        const logs = await Promise.all(
          runs.map(async (path) => JSON.parse(await readFile(path, "utf8"))),
        );
        const visited = logs.find((log) => log.hosts?.includes("127.0.0.1"));
        assert.ok(visited, JSON.stringify(logs));
        assert.equal(typeof visited.tabs.opened, "number", JSON.stringify(visited));
        assert.ok(Array.isArray(visited.files), JSON.stringify(visited));
        assert.ok(Array.isArray(visited.jobs), JSON.stringify(visited));
      });
      await t.test("help('network') and help('reading') mention the new calls", async () => {
        const out = await repl(
          `help('network');
          help('reading');
          console.log('RESULT done');`,
        );
        assert.match(out, /page\.network\.waitFor/, out);
        assert.match(out, /page\.data\(\{find/, out);
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

function json(output) {
  const line = /RESULT (.*)/.exec(output);
  assert.ok(line, output);
  return JSON.parse(line[1]);
}

async function findRunLogs(root) {
  const found = [];
  const walk = async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith(".json") && path.includes(sep + "runs" + sep)) found.push(path);
    }
  };
  await walk(root);
  return found;
}

/** A port that was free a moment ago: connecting to it is refused. */
async function closedPort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address();
  await new Promise((done) => server.close(done));
  return port;
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
