import assert from "node:assert/strict";
import test from "node:test";
import { spawn, execFile } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import WebSocket from "ws";

// The small browser e2e set for this task: tab reuse/closed notes, a silent click, and the
// site-code CLI. The full e2e file remains the broad regression suite.

const chromePath =
  process.env.CHROME_PATH ??
  resolve("../aeon-browser/.slice0-audit/chrome-for-testing-154.0.8037.57/chrome-win64/chrome.exe");
const extension = resolve("apps/extension/build");
const cli = resolve("apps/bridge/dist/cli.js");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const run = promisify(execFile);

test(
  "tab notes, silent clicks and site code work in real Chrome",
  {
    skip:
      !process.env.REQUIRE_E2E &&
      (!existsSync(chromePath) || !existsSync(extension) || !existsSync(cli)),
  },
  async (t) => {
    const home = await mkdtemp(join(tmpdir(), "bue-small-"));
    const env = {
      ...process.env,
      BROWSER_USE_EXTENSION_HOME: home,
      SITE_TO_API_HOME: join(home, "site-to-api"),
    };
    const site = createServer((request, response) => {
      const path = request.url ?? "/";
      if (path.startsWith("/silent")) {
        response.setHeader("content-type", "text/html");
        response.end(
          `<title>Silent card</title><div id="card" style="width:240px;height:120px;border:1px solid;position:relative"><span id="open" style="position:absolute;right:4px;top:4px;padding:8px">Open details</span></div><p id="out"></p><script>document.getElementById('open').addEventListener('click', () => { document.getElementById('out').textContent = 'opened'; });</script>`,
        );
        return;
      }
      if (path.startsWith("/ok")) {
        response.setHeader("content-type", "text/html");
        response.end(`<title>OK</title><p>${"readable text ".repeat(30)}</p>`);
        return;
      }
      if (path === "/code-fixture") {
        response.setHeader("content-type", "text/html");
        response.end(
          `<title>Code fixture</title><script src="/_next/static/build/_buildManifest.js"></script><script src="/code-fixture/app.js"></script>`,
        );
        return;
      }
      if (path === "/_next/static/build/_buildManifest.js") {
        response.end(`self.__BUILD_MANIFEST={"/account":["static/chunks/account.js"]};`);
        return;
      }
      if (path === "/code-fixture/app.js") {
        response.setHeader("content-type", "application/javascript");
        response.end(
          `const route = "/account/orders";\nconst needle = "checkout";\n//# sourceMappingURL=app.js.map\n`,
        );
        return;
      }
      if (path === "/code-fixture/app.js.map") {
        response.end(JSON.stringify({ sources: ["src/pages/account.tsx"] }));
        return;
      }
      response.setHeader("content-type", "text/html");
      response.end("<title>Shop</title><h1>Shop</h1>");
    });
    await new Promise((done) => site.listen(0, "127.0.0.1", done));
    const siteUrl = `http://127.0.0.1:${site.address().port}/`;
    const bridge = spawn(process.execPath, [cli, "serve"], { env, stdio: "ignore" });
    const profile = await mkdtemp(join(tmpdir(), "bue-small-chrome-"));
    let chrome;
    try {
      await waitFor(async () => readFile(join(home, "bridge.json"), "utf8"));
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

      await t.test("openTab reports reuse and a closed tab is a note", async () => {
        const { stdout } = await run(
          process.execPath,
          [
            cli,
            "repl",
            "--session",
            "tab-notes",
            `page = await browser.openTab(${JSON.stringify(siteUrl + "?reuse")});
            const a = page;
            const b = await browser.openTab(${JSON.stringify(siteUrl + "?reuse")});
            const url = await b.url();
            const closed = await browser.closeTab(b.id);
            const note = await b.click("button");
            const still = await (async () => {
              for (let i = 0; i < 50; i++) {
                if (!(await browser.tabs()).some((tab) => tab.id === b.id)) return false;
                await new Promise((done) => setTimeout(done, 50));
              }
              return true;
            })();
            console.log("TABNOTES " + JSON.stringify({
              same: a.id === b.id,
              reused: b.reused,
              hasId: typeof b.id === "number",
              hasUrl: /127\\.0\\.0\\.1/.test(String(url)),
              id: b.id,
              closed,
              note,
              still,
            }));`,
          ],
          { env },
        );
        const seen = JSON.parse(/TABNOTES (.*)/.exec(stdout)[1]);
        assert.equal(seen.same, true, stdout);
        assert.equal(seen.reused, true, stdout);
        assert.equal(seen.hasId, true, stdout);
        assert.equal(seen.hasUrl, true, stdout);
        assert.equal(seen.closed.closed, seen.id, stdout);
        assert.match(seen.note.note, /closed by you/, stdout);
        assert.equal(seen.still, false, stdout);
      });

      await t.test("a silent click says nothing happened", async () => {
        const { stdout } = await run(
          process.execPath,
          [
            cli,
            "repl",
            "--session",
            "silent-click",
            `page = await browser.openTab(${JSON.stringify(siteUrl + "silent")});
            const result = await page.locator("#card").click();
            const before = await page.textContent("#out");
            await page.locator("#open").click();
            const after = await page.textContent("#out");
            console.log("SILENT " + JSON.stringify({ note: result.note, before, after }));`,
          ],
          { env },
        );
        const seen = JSON.parse(/SILENT (.*)/.exec(stdout)[1]);
        assert.match(seen.note, /nothing happened/, stdout);
        assert.match(seen.note, /page\.clickAt/, stdout);
        assert.equal(seen.before, "", stdout);
        assert.equal(seen.after, "opened", stdout);
      });

      await t.test("code reads routes, chunks and source maps", async () => {
        const { stdout } = await run(
          process.execPath,
          [cli, "code", siteUrl + "code-fixture", "--grep", "checkout"],
          { env },
        );
        const value = JSON.parse(stdout);
        assert.ok(
          value.routes.some((route) => route.route === "/account"),
          stdout,
        );
        assert.ok(
          value.sourceMaps.some((item) => item.sources.includes("src/pages/account.tsx")),
          stdout,
        );
        assert.ok(
          value.matches.some((match) => match.text.includes("checkout")),
          stdout,
        );
      });

      await t.test("the check command reports counts and saves evidence", async () => {
        const work = await mkdtemp(join(home, "check-"));
        const { stdout } = await run(
          process.execPath,
          [cli, "check", siteUrl + "ok", "--via", "http", "--json"],
          { env, cwd: work },
        );
        const report = JSON.parse(stdout);
        assert.equal(report.counts.ok, 1, stdout);
        assert.equal(report.browserUsed, false, stdout);
        const folders = await readdir(join(work, "checks"));
        assert.equal(folders.length, 1, stdout);
        assert.ok(existsSync(join(work, "checks", folders[0], "results.json")), stdout);
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
      {
        env,
      },
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
