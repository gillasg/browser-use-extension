// End to end: the built extension in real Chrome, the bridge, the CLI and the MCP server.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createServer } from "node:http";
import { dataRoutes } from "./data-site.mjs";
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
// A 1x1 PNG.
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

test(
  "agents drive real Chrome through the bridge, the CLI and MCP",
  {
    skip:
      !process.env.REQUIRE_E2E &&
      (!existsSync(chromePath) || !existsSync(extension) || !existsSync(cli)),
  },
  async (t) => {
    const home = await mkdtemp(join(tmpdir(), "bue-home-"));
    // A throwaway Pi folder: model sign-in tests never touch real logins.
    const piHome = await mkdtemp(join(tmpdir(), "bue-pi-"));
    const env = {
      ...process.env,
      BROWSER_USE_EXTENSION_HOME: home,
      PI_CODING_AGENT_DIR: piHome,
      SITE_TO_API_HOME: join(home, "site-to-api"),
    };
    const site = createServer((request, response) => {
      if (request.url?.startsWith("/catalog")) {
        response.setHeader("content-type", "text/html");
        response.end(
          `<title>Catalog</title><h1>Catalog</h1><input id="q" placeholder="Search">
          <ul><li>Alpha</li><li>Beta</li><li>Gamma</li></ul>
          <button onclick="document.getElementById('out').textContent='added'">Add</button><p id="out"></p>
          <table><tr><th>Model</th><th>Price</th></tr><tr><td>iPhone 16</td><td>69,900</td></tr><tr><td>iPhone 16 Plus</td><td>79,900</td></tr></table>
          <a href="/catalog?page=2">Next page</a>`,
        );
        return;
      }
      if (request.url?.startsWith("/collapsed")) {
        // A narrow-layout search box folded behind a toggle, like Wikipedia in Split View.
        response.setHeader("content-type", "text/html");
        response.end(
          `<title>Collapsed</title><header><button class="search-toggle" aria-label="Search"
          onclick="document.getElementById('box').hidden=false">S</button>
          <div id="box" hidden><input name="search" placeholder="Search"></div></header>`,
        );
        return;
      }
      if (request.url?.startsWith("/media/photo.png")) {
        response.setHeader("content-type", "image/png");
        response.end(Buffer.from(PNG, "base64"));
        return;
      }
      if (request.url?.startsWith("/media")) {
        response.setHeader("content-type", "text/html");
        response.end(
          `<title>Media</title><img id="photo" src="/media/photo.png">
          <div id="drop" style="border:1px dashed">Drop photos here<input type="file" accept="image/*" multiple style="display:none"></div>`,
        );
        return;
      }
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
      if (dataRoutes(request, response)) return;
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

      await t.test("the popup can check models and open the model sign-in page", async () => {
        const status = await nativeBootstrap(env, { kind: "model.status" });
        assert.equal(status.ok, true);
        assert.deepEqual(status.connected, []);
        const login = await nativeBootstrap(env, { kind: "model.login" });
        assert.equal(login.ok, true, JSON.stringify(login));
        assert.match(login.url, /^http:\/\/127\.0\.0\.1:\d+\/#token=/);
        const page = await fetch(login.url.replace(/#.*/, ""));
        assert.match(await page.text(), /Connect an AI model/);
        // Other extensions can borrow the model; with none signed in, they are told so.
        const completion = await nativeBootstrap(env, {
          kind: "model.complete",
          system: "Be brief.",
          messages: [{ role: "user", content: "Hi" }],
        });
        assert.equal(completion.ok, false);
        assert.match(completion.error, /No AI model is connected/);
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
          // Linux CI runners forbid the user namespaces Chrome's sandbox needs.
          ...(process.platform === "linux" && process.env.CI ? ["--no-sandbox"] : []),
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
            `const first = page.target.tabId; await browser.openTab(${JSON.stringify(siteUrl + "api/items")}, {newTab: true}); const opened = page.url; await bu.use(first); [opened.endsWith("/api/items"), page.target.tabId === first]`,
          ],
          { env },
        );
        assert.match(stdout, /→ \[\s*true,\s*true\s*\]/);
      });

      await t.test(
        "common Playwright habits work: getTab, page.playwright, load states, wheel scrolls",
        async () => {
          const { stdout } = await run(
            process.execPath,
            [
              cli,
              "repl",
              `const tab = await browser.getTab(page.target.tabId); await tab.playwright.waitForLoadState('domcontentloaded'); await tab.waitForLoadState('load', { timeout: 20000 }); await tab.scroll({ deltaY: 300 }); await tab.scroll({ direction: 'up', amount: 300 }); await tab.title()`,
            ],
            { env },
          );
          assert.match(stdout, /→ "Shop"|→ Shop|bought/);
        },
      );

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

      await t.test("tabs are reused, permissions preset, and the cursor shows", async () => {
        const { stdout } = await run(
          process.execPath,
          [
            cli,
            "repl",
            "--session",
            "reuse",
            `const a = await browser.openTab(${JSON.stringify(siteUrl)});
            const b = await browser.openTab(${JSON.stringify(siteUrl)});
            const flat = (await browser.tabs()).every((tab) => typeof tab.tabId === "number");
            await page.setLocation(28.61, 77.21);
            const latitude = await page.evaluate(() => new Promise((done) =>
              navigator.geolocation.getCurrentPosition((p) => done(p.coords.latitude), (e) => done("error " + e.code))));
            await page.getByRole("button", { name: "Buy" }).click();
            const cursor = await page.evaluate(() => Boolean(document.getElementById("aeon-agent-cursor")));
            console.log("RESULT " + JSON.stringify({ reused: a.target.tabId === b.target.tabId, flat, latitude, cursor }))`,
          ],
          { env },
        );
        assert.match(stdout, /RESULT /, stdout);
        assert.deepEqual(JSON.parse(/RESULT (.*)/.exec(stdout)[1]), {
          reused: true,
          flat: true,
          latitude: 28.61,
          cursor: true,
        });
      });

      await t.test(
        "quiet reads, moving tabs, network list without start, large artifacts in pieces",
        async () => {
          await run(
            process.execPath,
            [
              cli,
              "repl",
              "--session",
              "quiet",
              `await browser.openTab(${JSON.stringify(siteUrl)})`,
            ],
            { env },
          );
          const read = await run(
            process.execPath,
            [cli, "repl", "--session", "quiet", "await page.evaluate(() => document.title)"],
            { env },
          );
          assert.doesNotMatch(read.stdout, /\[ok\] evaluate/, read.stdout);
          const { stdout } = await run(
            process.execPath,
            [
              cli,
              "repl",
              "--session",
              "quiet",
              `const first = await browser.openTab(${JSON.stringify(siteUrl + "?a")}, { newTab: true });
            const second = await browser.openTab(${JSON.stringify(siteUrl + "?b")}, { newTab: true });
            const [moved] = await browser.moveTab(second, { index: 0 });
            const listed = await second.network.list();
            const saved = await artifact("big.txt", "x".repeat(2500000) + "é");
            console.log("RESULT " + JSON.stringify({
              movedFirst: moved.index === 0 && moved.tabId === second.target.tabId,
              listed: Array.isArray(listed),
              bytes: saved.bytes,
            }))`,
            ],
            { env },
          );
          assert.match(stdout, /RESULT /, stdout);
          assert.deepEqual(JSON.parse(/RESULT (.*)/.exec(stdout)[1]), {
            movedFirst: true,
            listed: true,
            bytes: 2500002,
          });
          // A tab picked from browser.tabs() is attached by its listed entry.
          const attached = await run(
            process.execPath,
            [
              cli,
              "repl",
              "--session",
              "quiet",
              `const [listed] = await browser.tabs(${JSON.stringify(siteUrl + "?a")});
            const borrowed = await browser.attachTab(listed);
            const active = await browser.activeTab().catch((error) => error.message);
            console.log("ATTACHED " + JSON.stringify(await borrowed.evaluate(() => location.search)));
            console.log("GUESSES " + JSON.stringify({
              id: listed.id === listed.tabId,
              listedTitle: await listed.evaluate(() => document.title),
              active: typeof active.tabId === "number" || /not a web page/.test(active),
              snapshot: typeof (await borrowed.domSnapshot()) === "string",
            }));
            await borrowed.goto(${JSON.stringify(siteUrl + "collapsed")});
            const hidden = await borrowed.locator("input[name=search]").fill("x").catch((error) => String(error.message));
            console.log("HIDDEN " + JSON.stringify(hidden))`,
            ],
            { env },
          );
          assert.match(attached.stdout, /ATTACHED "\?a"/, attached.stdout + attached.stderr);
          assert.deepEqual(JSON.parse(/GUESSES (.*)/.exec(attached.stdout)[1]), {
            id: true,
            listedTitle: "Shop",
            active: true,
            snapshot: true,
          });
          assert.match(
            attached.stdout,
            /HIDDEN .*TARGET_HIDDEN.*button\.search-toggle/,
            attached.stdout,
          );
        },
      );

      await t.test(
        "recording: own window, timed actions, hover, mouse steps, onCdp, recordTab",
        async () => {
          const { stdout } = await run(
            process.execPath,
            [
              cli,
              "repl",
              "--session",
              "record",
              `const p = await browser.openTab(${JSON.stringify(siteUrl)}, { window: { width: 900, height: 700 } });
            const recording = await p.recordTab({ fps: 30, name: "demo" });
            const hovered = await p.getByRole("button", { name: "Buy" }).hover();
            const clicked = await p.getByRole("button", { name: "Buy" }).click();
            const box = await p.getByRole("button", { name: "Buy" }).boundingBox();
            const moves = [];
            const stream = p.onCdp("Runtime.consoleAPICalled", (params) => moves.push(params.type));
            await stream.ready;
            await p.cdp("Runtime.enable", {});
            await p.evaluate(() => { console.log("one"); console.warn("two"); });
            const before = Date.now();
            await p.mouse.move(10, 10);
            await p.mouse.move(300, 200, { steps: 20 });
            const moveMs = Date.now() - before;
            await new Promise((done) => setTimeout(done, 1500));
            await stream.stop();
            const summary = await recording.stop();
            console.log("RESULT " + JSON.stringify({
              hovered: Boolean(hovered.box && hovered.box.width > 0 && hovered.tStart <= hovered.tEnd),
              clicked: Boolean(clicked.box && clicked.tEnd >= clicked.tStart),
              box: box.width > 0 && box.height > 0,
              logs: moves.includes("log") && moves.includes("warning"),
              fastMoves: moveMs < 4000,
              frames: summary.frames > 0,
              folder: summary.folder,
            }))`,
            ],
            { env },
          );
          assert.match(stdout, /RESULT /, stdout);
          assert.deepEqual(JSON.parse(/RESULT (.*)/.exec(stdout)[1]), {
            hovered: true,
            clicked: true,
            box: true,
            logs: true,
            fastMoves: true,
            frames: true,
            folder: "demo",
          });
        },
      );

      await t.test(
        "Playwright-style calls, extraction, one group for parallel tabs, Google parsing",
        async () => {
          const catalog = siteUrl + "catalog";
          const { stdout } = await run(
            process.execPath,
            [
              cli,
              "repl",
              "--session",
              "playwright",
              `page = await browser.openTab(${JSON.stringify(catalog)});
            const title = await page.title();
            const url = page.url();
            const count = await page.locator("li").count();
            const second = await page.locator("li").nth(1).innerText();
            const texts = await page.locator("li").allInnerTexts();
            const heading = await page.$eval("h1", (el) => el.textContent);
            const items = await page.$$eval("li", (els) => els.length);
            await page.getByRole("button", { name: "Add" }).click();
            const added = await page.textContent("#out");
            await page.fill("#q", "phones");
            const typed = await page.inputValue("#q");
            const rows = await page.table("table");
            const links = (await page.links()).map((link) => link.text);
            const regexText = await page.getByText(/^Gam/).innerText();
            await page.evaluate(() => { document.getElementById("out").textContent = ""; });
            await page.getByRole("button", { name: /^ad+$/i }).click();
            const regexClick = await page.textContent("#out");
            const viaTab = String((await browser.tab(page.target.tabId)).url);
            await page.evaluate(() => { const d = document.createElement("div"); d.setAttribute("role", "dialog"); d.setAttribute("aria-label", "Enter your origin"); d.style.cssText = "position:fixed;inset:0;background:#fff"; d.innerHTML = '<input aria-label="Where else?">'; document.body.append(d); });
            const blocked = await page.getByRole("button", { name: "Add" }).click().then(() => "clicked", (error) => String(error.message || error));
            await page.evaluate(() => document.querySelector("[role=dialog]").remove());
            await page.evaluate(() => { const d = document.createElement("div"); d.setAttribute("role", "dialog"); d.style.cssText = "position:fixed;inset:0;background:#fff;padding:40px"; d.onclick = (event) => { if (event.target === d) document.title = "dialog-clicked"; }; d.innerHTML = '<label style="display:block"><input id="inner" type="checkbox" style="pointer-events:none"> Option</label><div id="bare" style="pointer-events:none;width:40px;height:20px"><input id="plain" type="checkbox" style="pointer-events:none"></div>'; document.body.append(d); });
            const ancestorHit = await page.locator("#inner").click().then(() => "clicked", (error) => String(error.message || error));
            const innerChecked = await page.evaluate(() => document.querySelector("#inner").checked);
            const plainHit = await page.locator("#plain").click().then(() => "clicked", (error) => String(error.message || error));
            const plainChecked = await page.evaluate(() => document.querySelector("#plain").checked);
            const ancestorTitle = await page.title();
            await page.evaluate(() => document.querySelector("[role=dialog]").remove());
            const filtered = await page.locator("li").filter({ hasText: "Beta" }).first().textContent();
            const orTexts = await page.locator("li").filter({ hasText: "Gamma" }).or(page.locator("li").filter({ hasText: "Alpha" })).allInnerTexts();
            const andCount = await page.locator("li").and(page.locator("li").filter({ hasText: "Beta" })).count();
            await page.wait(50);
            await page.waitForSelector("body", { timeout: 20000 });
            await page.console({ clear: true });
            await page.evaluate(() => console.error("boom from page"));
            const consoleErrors = (await page.console({ errors: true })).map((entry) => entry.text).join(" ");
            await page.dialogs("dismiss");
            const confirmed = await page.evaluate(() => window.confirm("Remove item?"));
            const pdf = await page.pdf("catalog.pdf");
            await page.emulate({ device: "iPhone", colorScheme: "dark" });
            const mobile = await page.evaluate(() => ({ w: screen.width, dark: matchMedia("(prefers-color-scheme: dark)").matches, ua: /iPhone/.test(navigator.userAgent) }));
            await page.emulate({ reset: true });
            const downloads = Array.isArray(await browser.downloads.list());
            const tabs = await Promise.all(["a", "b", "c"].map((q) => browser.openTab(${JSON.stringify(siteUrl)} + "?q=" + q)));
            const sample = '<div data-rpos="0"><a href="/url?q=https://example.com/one"><h3>One result</h3></a><span>First snippet</span></div>' +
              '<div data-rpos="1"><a href="https://www.google.com/x"><h3>Google itself</h3></a></div>';
            const parsed = __parseGoogle(sample, 5);
            console.log("RESULT " + JSON.stringify({ title, url, count, second, texts, heading, items, added, typed, rows, links, parsed, regexText, regexClick, viaTab, blocked, ancestorHit, innerChecked, plainHit, plainChecked, ancestorTitle, filtered, orTexts, andCount, consoleErrors, confirmed, pdf, mobile, downloads,
              tabIds: tabs.map((tab) => tab.target.tabId) }))`,
            ],
            { env },
          );
          assert.match(stdout, /RESULT /, stdout);
          const result = JSON.parse(/RESULT (.*)/.exec(stdout)[1]);
          assert.equal(result.title, "Catalog");
          assert.equal(result.url, catalog);
          assert.equal(result.count, 3);
          assert.equal(result.second, "Beta");
          assert.deepEqual(result.texts, ["Alpha", "Beta", "Gamma"]);
          assert.equal(result.heading, "Catalog");
          assert.equal(result.items, 3);
          assert.equal(result.added, "added");
          assert.equal(result.regexText, "Gamma");
          assert.equal(result.regexClick, "added");
          assert.equal(result.viaTab, catalog);
          assert.match(result.consoleErrors, /boom from page/);
          assert.equal(result.confirmed, false);
          assert.deepEqual(result.pdf, { saved: "catalog.pdf" });
          assert.deepEqual(result.mobile, { w: 390, dark: true, ua: true });
          assert.equal(result.downloads, true);
          assert.match(
            result.blocked,
            /TARGET_BLOCKED: covered by dialog "Enter your origin"; its fields: "Where else."/,
          );
          assert.equal(result.ancestorHit, "clicked");
          assert.equal(result.innerChecked, true);
          assert.equal(result.plainHit, "clicked");
          assert.equal(result.plainChecked, true);
          assert.notEqual(result.ancestorTitle, "dialog-clicked");
          assert.equal(result.filtered, "Beta");
          assert.deepEqual(result.orTexts, ["Alpha", "Gamma"]);
          assert.equal(result.andCount, 1);
          assert.equal(result.typed, "phones");
          assert.deepEqual(result.rows, [
            { Model: "iPhone 16", Price: "69,900" },
            { Model: "iPhone 16 Plus", Price: "79,900" },
          ]);
          assert.ok(result.links.includes("Next page"));
          assert.deepEqual(result.parsed, [
            {
              title: "One result",
              url: "https://example.com/one",
              source: "example.com",
              snippet: "First snippet",
            },
          ]);
          const groups = await worker("Runtime.evaluate", {
            expression: `Promise.all(${JSON.stringify(result.tabIds)}.map((id) => chrome.tabs.get(id))).then((tabs) => [...new Set(tabs.map((tab) => tab.groupId))])`,
            awaitPromise: true,
            returnByValue: true,
          });
          assert.equal(groups.result.result.value.length, 1, "parallel tabs share one group");
          assert.notEqual(groups.result.result.value[0], -1);
        },
      );

      await t.test(
        "network capture, page requests, page data, Markdown, fetch and the tab pool",
        async () => {
          const deals = siteUrl + "deals";
          const { stdout } = await run(
            process.execPath,
            [
              cli,
              "repl",
              "--session",
              "data",
              `page = await browser.openTab(${JSON.stringify(siteUrl)});
            await page.network.start();
            await page.goto(${JSON.stringify(deals)});
            await page.waitFor(() => document.readyState === "complete");
            let calls = [];
            for (let tries = 0; tries < 50 && !calls.some((call) => !call.loading); tries++) {
              calls = await page.network.list("/api/search");
              if (!calls.some((call) => !call.loading)) await new Promise((done) => setTimeout(done, 100));
            }
            const call = await page.network.get(calls[0].id);
            const body = await page.network.body(calls[0].id);
            const replayed = await page.replay(calls[0].id, { json: { page: 2 }, query: { q: "laptop" } });
            const requested = await page.request("/api/echo", { method: "POST", json: { a: 1 }, csrf: true });
            await page.network.stop();
            // A stopped recording can still be read and saved.
            const har = await page.network.har();
            const data = await page.data();
            const markdown = await page.markdown();
            const fetched = await browser.fetch(${JSON.stringify(siteUrl + "api/items")});
            const httpStatus = await page.status();
            const pooled = await browser.pool([1, 2, 3, 4].map((n) => ${JSON.stringify(siteUrl)} + "item/" + n),
              async (tab) => tab.title(), { concurrency: 2 });
            console.log("RESULT " + JSON.stringify({
              type: call.type, method: call.method, signature: call.requestHeaders["x-signature"],
              requestBody: JSON.parse(call.requestBody), initiator: call.initiator?.type,
              setCookie: Object.keys(call.responseHeaders).some((name) => name.toLowerCase() === "set-cookie"),
              bodyQuery: body.query, replayed: [replayed.json.query.q, replayed.json.body.page, replayed.json.body.q, replayed.json.signature],
              csrf: requested.json.csrf, harEntries: har.log.entries.some((entry) => entry.request.url.includes("/api/search")),
              jsonLd: data.jsonLd[0].name, next: data.nextData.props.pageProps.items[0].name,
              canonical: data.metadata.canonical, og: data.metadata.meta["og:title"],
              markdown, fetched: fetched.json.items.length, status: httpStatus,
              pooled: pooled.map((result) => result.ok && result.value),
            }));`,
            ],
            { env },
          );
          assert.match(stdout, /RESULT /, stdout);
          const result = JSON.parse(/RESULT (.*)/.exec(stdout)[1]);
          assert.equal(result.type, "Fetch");
          assert.equal(result.method, "POST");
          assert.equal(result.signature, "sig-1");
          assert.deepEqual(result.requestBody, { q: "phone", page: 1 });
          assert.equal(result.initiator, "script");
          assert.equal(result.setCookie, true);
          assert.deepEqual(result.bodyQuery, { q: "phone" });
          assert.deepEqual(result.replayed, ["laptop", 2, null, "sig-1"]);
          assert.equal(result.csrf, "token-123");
          assert.equal(result.harEntries, true);
          assert.equal(result.jsonLd, "Phone");
          assert.equal(result.next, "Phone");
          assert.equal(result.canonical, "https://shop.example/deals");
          assert.equal(result.og, "Deals page");
          assert.match(result.markdown, /^# Deals/);
          assert.match(result.markdown, /Prices from \*\*today\*\* ?, see \[terms\]\(http/);
          assert.match(result.markdown, /- Phone\n- Laptop/);
          assert.match(
            result.markdown,
            /\| Item \| Price \|\n\| --- \| --- \|\n\| Phone \| 699 \|/,
          );
          assert.match(result.markdown, /```\ncode block\n```/);
          assert.doesNotMatch(result.markdown, /Footer text|About/);
          assert.equal(result.fetched, 3);
          assert.equal(result.status, 200);
          assert.deepEqual(result.pooled, ["Item 1", "Item 2", "Item 3", "Item 4"]);
        },
      );

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
            ["browser_code", "browser_tabs", "crawl", "site_api"],
          );
          const crawled = await mcp.call("tools/call", {
            name: "crawl",
            arguments: { action: "scrape", url: siteUrl, render: "static" },
          });
          assert.match(crawled.content[0].text, /Shop/, JSON.stringify(crawled));
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

      await t.test(
        "media: images are saved to the workspace and uploaded through a drop zone",
        async () => {
          const { stdout } = await run(
            process.execPath,
            [
              cli,
              "repl",
              "--session",
              "media",
              `const p = await browser.openTab(${JSON.stringify(siteUrl + "media")});
            const saved = await p.saveMedia("#photo");
            const fromUrl = await p.saveMedia(${JSON.stringify(siteUrl + "media/photo.png")}, { name: "again.png" });
            await p.upload("#drop", [saved[0].saved, ${JSON.stringify(siteUrl + "media/photo.png")}]);
            const picked = await p.evaluate(() => [...document.querySelector("input[type=file]").files].map((f) => f.size));
            console.log("RESULT " + JSON.stringify({ saved: saved[0].saved, mime: saved[0].mime, again: fromUrl[0].saved, picked }))`,
            ],
            { env },
          );
          assert.match(stdout, /RESULT /, stdout);
          const result = JSON.parse(/RESULT (.*)/.exec(stdout)[1]);
          assert.equal(result.saved, "media/photo.png");
          assert.equal(result.mime, "image/png");
          assert.equal(result.again, "media/again.png");
          const size = Buffer.from(PNG, "base64").length;
          assert.deepEqual(result.picked, [size, size]);
        },
      );

      await t.test("browser code reaches mapped site APIs through siteApi", async () => {
        const { stdout } = await run(
          process.execPath,
          [
            cli,
            "repl",
            "--session",
            "site-api",
            `const sites = await siteApi.sites();
            const missing = await siteApi.call("nope.example", "x").then(() => "called", (e) => String(e.message));
            console.log("RESULT " + JSON.stringify({ sites, missing }))`,
          ],
          { env },
        );
        assert.match(stdout, /RESULT /, stdout);
        const result = JSON.parse(/RESULT (.*)/.exec(stdout)[1]);
        assert.deepEqual(result.sites, []);
        assert.match(result.missing, /not mapped/);
      });

      await t.test("a saved boost applies on every visit until it is removed", async () => {
        const repl = (code) =>
          run(process.execPath, [cli, "repl", "--session", "boosts", code], { env });
        const color = `(await browser.openTab(${JSON.stringify(siteUrl)}, { new: true })).evaluate(() => getComputedStyle(document.querySelector("h1")).color)`;
        const saved = await repl(
          `const boost = await browser.boosts.save({ name: "Red headings", sites: [{ type: "domain", value: "127.0.0.1" }], css: "h1 { color: rgb(200, 0, 0) !important }" });
          await new Promise((done) => setTimeout(done, 500));
          console.log("RESULT " + JSON.stringify({ id: boost.id, color: await ${color}, listed: (await browser.boosts.list()).length }))`,
        );
        assert.match(saved.stdout, /RESULT /, saved.stdout);
        const first = JSON.parse(/RESULT (.*)/.exec(saved.stdout)[1]);
        assert.equal(first.color, "rgb(200, 0, 0)");
        assert.equal(first.listed, 1);
        const removed = await repl(
          `await browser.boosts.remove(${JSON.stringify(first.id)});
          console.log("RESULT " + JSON.stringify({ color: await ${color}, listed: (await browser.boosts.list()).length }))`,
        );
        assert.match(removed.stdout, /RESULT /, removed.stdout);
        const after = JSON.parse(/RESULT (.*)/.exec(removed.stdout)[1]);
        assert.notEqual(after.color, "rgb(200, 0, 0)");
        assert.equal(after.listed, 0);
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

      await t.test("demonstrations record a flow and generate a replayable skill", async () => {
        const { stdout } = await run(
          process.execPath,
          [
            cli,
            "repl",
            "--session",
            "demo",
            `page = await browser.openTab(${JSON.stringify(siteUrl + "catalog")});
            const demo = await page.recordDemonstration();
            await page.locator("#q").fill("Alpha");
            await page.getByRole("button", { name: "Add" }).click();
            const recorded = await demo.stop();
            console.log("RESULT " + JSON.stringify({ steps: recorded.steps.length, kinds: recorded.steps.map((step) => step.kind), code: recorded.code.includes(".fill(") && recorded.code.includes(".click("), skill: recorded.skill.code.includes("async function") }))`,
          ],
          { env },
        );
        assert.match(stdout, /RESULT /, stdout);
        const result = JSON.parse(/RESULT (.*)/.exec(stdout)[1]);
        assert.ok(result.steps >= 2, JSON.stringify(result));
        assert.ok(result.kinds.includes("fill"), JSON.stringify(result));
        assert.ok(result.kinds.includes("click"), JSON.stringify(result));
        assert.equal(result.code, true);
        assert.equal(result.skill, true);
      });

      await t.test("screenshot diff finds a visual change and writes a diff PNG", async () => {
        const { stdout } = await run(
          process.execPath,
          [
            cli,
            "repl",
            "--session",
            "diff",
            `page = await browser.openTab(${JSON.stringify(siteUrl + "catalog")});
            await page.waitForSelector("#q");
            await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
            await page.evaluate(() => { document.getElementById("aeon-agent-cursor")?.remove(); document.documentElement.style.background = "#fff"; document.body.style.background = "#fff"; });
            await page.evaluate(() => new Promise((done) => requestAnimationFrame(done)));
            const before = await page.screenshot();
            const same = await page.diffScreenshot(before);
            await page.evaluate(() => { document.body.style.background = "#123456"; });
            const changed = await page.diffScreenshot(before, { path: "diff.png" });
            console.log("RESULT " + JSON.stringify({ sameRatio: same.changedRatio, changed: changed.matches, pixels: changed.changedPixels, path: changed.path }))`,
          ],
          { env },
        ).catch((error) => {
          console.log(error.stdout);
          throw error;
        });
        assert.match(stdout, /RESULT /, stdout);
        const result = JSON.parse(/RESULT (.*)/.exec(stdout)[1]);
        assert.ok(result.sameRatio < 0.01, JSON.stringify(result));
        assert.equal(result.changed, false, JSON.stringify(result));
        assert.ok(result.pixels > 100000, JSON.stringify(result));
        assert.equal(result.path, "diff.png");
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

function nativeBootstrap(env, message) {
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
      JSON.stringify(
        message ?? {
          kind: "native.bootstrap",
          protocolVersion: { major: 1, minor: 6 },
          clientInstanceId: "091b9308-1ee9-420e-b71f-a564a5a27701",
          browserRunId: "3ee7ba6e-5aad-4692-9e4e-fb4cff0964f8",
        },
      ),
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
