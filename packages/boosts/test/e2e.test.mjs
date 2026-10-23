// End to end: the built extension in a private, headless Chrome for Testing, against a local site.
import assert from "node:assert/strict";
import test from "node:test";
import { canRun, EXTENSION_ID, launch, waitFor } from "./browser.mjs";
import { startSite } from "./fixture-site.mjs";

const hidden = (selector) =>
  `[...document.querySelectorAll(${JSON.stringify(selector)})].map((el) => getComputedStyle(el).display === "none")`;

const cases = [];

cases.push([
  "styles, zaps (also text-matched and late ones) and added HTML apply",
  async ({ ext, open, site, fresh, host }) => {
    await fresh();
    await ext("boost.create", {
      boost: {
        name: "Tidy news",
        sites: [{ type: "domain", value: host }],
        css: "header#top { background: rgb(1, 2, 3); }",
        zaps: [{ selector: "aside.sidebar" }, { selector: "article.story", contains: "Sponsored" }],
        html: [
          { selector: "#top", position: "after", html: '<p id="added">Hello from a boost</p>' },
        ],
      },
    });
    const page = await open(`${site.origin}/news`);
    await waitFor(
      () =>
        page.evaluate(
          `getComputedStyle(document.getElementById("top")).backgroundColor === "rgb(1, 2, 3)"`,
        ),
      5000,
      "the style",
    );
    assert.deepEqual(await page.evaluate(hidden("aside")), [true]);
    await waitFor(
      async () =>
        JSON.stringify(await page.evaluate(hidden("article.story"))) ===
        JSON.stringify([false, true, false, true, true]),
      5000,
      "sponsored stories, including the late one, hidden",
    );
    assert.equal(await page.evaluate(`document.querySelectorAll("#added").length`), 1);
    await page.close();
  },
]);

cases.push([
  "actions dismiss a banner that appears later, and sort a list by price",
  async ({ ext, open, site, fresh, host }) => {
    await fresh();
    await ext("boost.create", {
      boost: {
        name: "No banners",
        sites: [{ type: "domain", value: host }],
        actions: [{ do: "click", text: "Accept all" }],
      },
    });
    await ext("boost.create", {
      boost: {
        name: "Cheapest first",
        sites: [{ type: "prefix", value: `${site.origin}/shop` }],
        actions: [{ do: "sort", items: "li.product", key: ".price", numeric: true }],
      },
    });
    const news = await open(`${site.origin}/news`);
    await waitFor(
      () => news.evaluate("window.__accepted === true && !document.getElementById('consent')"),
      5000,
      "the banner to be accepted",
    );
    const shop = await open(`${site.origin}/shop`);
    await waitFor(
      async () =>
        (await shop.evaluate(
          `[...document.querySelectorAll(".name")].map((n) => n.textContent).join(",")`,
        )) === "Paper lamp,Desk lamp,Brass lamp",
      5000,
      "sorted products",
    );
    await news.close();
    await shop.close();
  },
]);

cases.push([
  "network rules block what the site loads from elsewhere",
  async ({ ext, open, site, fresh, host }) => {
    await fresh();
    await ext("boost.create", {
      boost: {
        name: "No pixels",
        sites: [{ type: "domain", value: host }],
        network: [{ action: "block", domains: ["localhost"] }],
      },
    });
    const before = site.state.pixelHits;
    const page = await open(`${site.origin}/news`);
    await new Promise((done) => setTimeout(done, 800));
    assert.equal(site.state.pixelHits, before, "the pixel on another host was not loaded");
    assert.equal(await page.evaluate(`document.getElementById("pixel").naturalWidth`), 0);
    await page.close();
  },
]);

cases.push([
  "switching a site off stops its boosts; switching one boost off on a site stops only it",
  async ({ ext, open, site, fresh, host }) => {
    await fresh();
    const boost = await ext("boost.create", {
      boost: {
        name: "Hide sidebar",
        sites: [{ type: "domain", value: host }],
        zaps: [{ selector: "aside.sidebar" }],
      },
    });
    await ext("site.toggle", { host, on: false });
    const page = await open(`${site.origin}/news`);
    await new Promise((done) => setTimeout(done, 400));
    assert.deepEqual(await page.evaluate(hidden("aside")), [false]);
    await ext("site.toggle", { host, on: true });
    await waitFor(
      async () => (await page.evaluate(hidden("aside")))[0] === true,
      5000,
      "the boost back on",
    );
    await ext("site.boost", { host, id: boost.id, on: false });
    await waitFor(
      async () => (await page.evaluate(hidden("aside")))[0] === false,
      5000,
      "the boost off on this site",
    );
    await ext("site.boost", { host, id: boost.id, on: true });
    await page.close();
  },
]);

cases.push([
  "a .user.js link opens the install page; the script gets its API, @require, @resource and @connect",
  async ({ ext, open, site, chrome, fresh }) => {
    await fresh();
    const page = await open();
    await page.cdp.call("Page.enable");
    await page.cdp.call("Page.navigate", { url: `${site.origin}/scripts/test.user.js` });
    await waitFor(
      async () => (await page.url()).startsWith(`chrome-extension://${EXTENSION_ID}/install.html`),
      10000,
      "the install page",
    );
    await waitFor(
      () =>
        page.evaluate(
          `[...document.querySelectorAll("button")].some((b) => b.textContent === "Install")`,
        ),
      10000,
      "the install button",
    );
    const review = await page.evaluate("document.body.innerText");
    assert.match(review, /Test helper/);
    assert.match(review, /send requests, with your logins, to: localhost/);
    await page.evaluate(
      `[...document.querySelectorAll("button")].find((b) => b.textContent === "Install").click()`,
    );
    await waitFor(
      () => page.evaluate(`document.body.innerText.includes("Installed")`),
      10000,
      "installed",
    );
    await page.navigate(`${site.origin}/news`);
    await waitFor(
      () => page.evaluate(`document.body.dataset.price === "499"`),
      10000,
      "GM_xmlhttpRequest to an allowed host",
    );
    assert.equal(await page.evaluate("document.body.dataset.visits"), "1");
    assert.equal(
      await page.evaluate("document.body.dataset.lib"),
      "1",
      "@require ran first, after its hash was checked",
    );
    assert.equal(await page.evaluate("document.body.dataset.greeting"), "hello from a resource");
    assert.equal(await page.evaluate("document.body.dataset.handler"), "Site Boosts");
    assert.match(
      await page.evaluate(`getComputedStyle(document.getElementById("top")).outlineColor`),
      /rgb\(255, 0, 0\)/,
    );
    // Values persist between visits, and the menu command reaches the page.
    await new Promise((done) => setTimeout(done, 1200));
    await page.navigate(`${site.origin}/news?again`);
    await waitFor(
      () => page.evaluate(`document.body.dataset.visits === "2"`),
      10000,
      "the stored value on the next visit",
    );
    const tabId = await chrome.tabId(page);
    const menu = await waitFor(
      async () => (await ext("tab.plan", { tabId })).menu.find((m) => m.caption === "Say hi"),
      5000,
      "the menu command",
    );
    await ext("menu.run", { tabId, boostId: menu.boostId, id: menu.id });
    await waitFor(
      () => page.evaluate(`document.body.dataset.menu === "clicked"`),
      5000,
      "the menu command to run",
    );
    await page.close();
  },
]);

cases.push([
  "a userstyle applies per section, with its settings",
  async ({ ext, open, site, fresh }) => {
    await fresh();
    const source = await fetch(`${site.origin}/scripts/test.user.css`).then((r) => r.text());
    const prepared = await ext("install.prepare", {
      source,
      url: `${site.origin}/scripts/test.user.css`,
    });
    const style = await ext("install.confirm", { prepared });
    const page = await open(`${site.origin}/news`);
    await waitFor(
      () =>
        page.evaluate(`getComputedStyle(document.querySelector("h1")).color === "rgb(0, 0, 255)"`),
      5000,
      "the style's colour",
    );
    assert.equal(
      await page.evaluate(`getComputedStyle(document.body).display`),
      "block",
      "sections for other sites do not apply",
    );
    await ext("boost.save", { boost: { ...style, varValues: { headline: "#00ff00" } } });
    await waitFor(
      () =>
        page.evaluate(`getComputedStyle(document.querySelector("h1")).color === "rgb(0, 255, 0)"`),
      5000,
      "the new colour",
    );
    await page.close();
  },
]);

cases.push([
  "styles still apply on a page whose security policy blocks inline styles",
  async ({ ext, open, site, fresh }) => {
    await fresh();
    await ext("boost.create", {
      boost: {
        name: "Red title",
        sites: [{ type: "prefix", value: `${site.origin}/strict` }],
        css: "#title { color: rgb(200, 0, 0) !important; }",
      },
    });
    const page = await open(`${site.origin}/strict`);
    await waitFor(
      () =>
        page.evaluate(
          `getComputedStyle(document.getElementById("title")).color === "rgb(200, 0, 0)"`,
        ),
      5000,
      "the style despite the policy",
    );
    await page.close();
  },
]);

cases.push([
  "JavaScript boosts: SB helpers add a panel with data from another site",
  async ({ ext, open, site, fresh, host }) => {
    await fresh();
    await ext("boost.create", {
      boost: {
        name: "Price panel",
        sites: [{ type: "domain", value: host }],
        js: `SB.onElement("#top", async (top) => { const data = await SB.fetch("${site.adsOrigin}/api/price", { as: "json" }); const body = SB.panel({ title: "Elsewhere", html: "<b>₹" + data.price + "</b>", anchor: top, position: "after" }); body.id = "sb-panel-body"; });`,
      },
    });
    const page = await open(`${site.origin}/news`);
    await waitFor(
      () =>
        page.evaluate(
          `document.querySelector("site-boosts-panel")?.shadowRoot?.textContent.includes("₹499")`,
        ),
      10000,
      "the panel",
    );
    await page.close();
  },
]);

cases.push([
  "scripts kept apart from the page still get stored values and requests",
  async ({ ext, open, site, fresh, host }) => {
    await fresh();
    await ext("boost.create", {
      boost: {
        name: "Isolated",
        sites: [{ type: "domain", value: host }],
        jsWorld: "isolated",
        js: `const n = (GM_getValue("n", 0) || 0) + 1; GM_setValue("n", n); SB.fetch("${site.adsOrigin}/api/price", { as: "json" }).then((d) => { document.body.dataset.isolated = n + ":" + d.price; });`,
      },
    });
    const page = await open(`${site.origin}/news`);
    await waitFor(
      () => page.evaluate(`document.body.dataset.isolated === "1:499"`),
      10000,
      "the isolated script",
    );
    assert.equal(
      await page.evaluate("typeof window.GM_getValue"),
      "undefined",
      "nothing leaks into the page",
    );
    await page.close();
  },
]);

cases.push([
  "plain English: preview, change by talking, keep; then an unclear request gets a question",
  async ({ ext, open, site, chrome, fresh }) => {
    await fresh();
    await ext("settings.set", {
      patch: {
        model: { provider: "custom", baseUrl: `${site.origin}/model/v1`, model: "test-model" },
      },
    });
    const page = await open(`${site.origin}/news`);
    const tabId = await chrome.tabId(page);
    const first = await ext("author.run", { tabId, request: "hide the sidebar" });
    assert.equal(first.boost.name, "Calmer news");
    await waitFor(
      async () => (await page.evaluate(hidden("aside")))[0] === true,
      5000,
      "the preview",
    );
    assert.equal((await ext("boosts.list")).boosts.length, 0, "a preview is not saved");
    assert.match(
      site.state.modelCalls.at(-1).messages.at(-1).content,
      /Page outline:[\s\S]*aside\.sidebar/,
      "the model saw the page",
    );
    const second = await ext("author.run", { tabId, request: "also hide sponsored stories" });
    assert.match(second.diff, /\+ article\.story \(containing "Sponsored"\)/);
    await waitFor(
      async () => (await page.evaluate(hidden("article.story")))[1] === true,
      5000,
      "the changed preview",
    );
    const kept = await ext("author.keep", { tabId });
    const { boost, revisions } = await ext("boost.get", { id: kept.id });
    assert.equal(boost.zaps.length, 2);
    assert.equal(revisions[0].by, "ai");
    assert.deepEqual(
      boost.chat.map((turn) => turn.role),
      ["user", "assistant", "user", "assistant"],
      "the conversation is kept, to change it later",
    );
    const question = await ext("author.run", { tabId, request: "make it unclear" });
    assert.equal(question.boost, undefined);
    assert.match(question.reply, /Which part/);
    await page.close();
  },
]);

cases.push([
  "a redesign breaks a boost; it is repaired automatically, and the repair can be undone",
  async ({ ext, open, site, chrome, fresh, host }) => {
    await fresh();
    site.state.redesign = false;
    const boost = await ext("boost.create", {
      boost: {
        name: "Hide the sidebar",
        sites: [{ type: "domain", value: host }],
        zaps: [{ selector: "aside.sidebar" }],
      },
    });
    const page = await open(`${site.origin}/news`);
    const report = async () => {
      await page.evaluate("new Promise((r) => setTimeout(r, 900))");
      await ext("tab.send", { tabId: await chrome.tabId(page), message: "health.now" });
    };
    await report();
    assert.equal((await ext("boost.get", { id: boost.id })).health.status, "ok");
    site.state.redesign = true;
    for (let visit = 0; visit < 2; visit++) {
      await page.navigate(`${site.origin}/news?visit=${visit}`);
      await report();
    }
    const repaired = await waitFor(
      async () => {
        const { boost: current, revisions } = await ext("boost.get", { id: boost.id });
        return revisions[0].by === "repair" ? current : undefined;
      },
      10000,
      "the repair",
    );
    assert.equal(repaired.zaps[0].selector, "aside.side-rail");
    await waitFor(
      async () => (await page.evaluate(hidden("aside")))[0] === true,
      5000,
      "the new sidebar hidden",
    );
    await ext("boost.undo", { id: boost.id });
    assert.equal(
      (await ext("boost.get", { id: boost.id })).boost.zaps[0].selector,
      "aside.sidebar",
    );
    site.state.redesign = false;
    await page.close();
  },
]);

cases.push([
  "the chip lists this page's boosts and switches one off here",
  async ({ ext, open, site, fresh, host }) => {
    await fresh();
    await ext("boost.create", {
      boost: {
        name: "Hide the sidebar",
        sites: [{ type: "domain", value: host }],
        zaps: [{ selector: "aside.sidebar" }],
      },
    });
    const page = await open(`${site.origin}/news`);
    const chip = `document.querySelector("site-boosts-chip").shadowRoot`;
    await waitFor(
      () => page.evaluate(`${chip}.querySelector(".pill")?.textContent.includes("1")`),
      5000,
      "the chip",
    );
    await page.evaluate(`${chip}.querySelector(".pill").click()`);
    assert.match(await page.evaluate(`${chip}.textContent`), /Hide the sidebar/);
    await page.evaluate(
      `${chip}.querySelector('[aria-label="Hide the sidebar on this site"]').click()`,
    );
    await waitFor(
      async () => (await page.evaluate(hidden("aside")))[0] === false,
      5000,
      "the boost off on this site",
    );
    await page.close();
  },
]);

cases.push([
  "zap: click an element to hide it, shift-click to hide everything like it",
  async ({ ext, open, site, chrome, fresh }) => {
    await fresh();
    const page = await open(`${site.origin}/news`);
    const tabId = await chrome.tabId(page);
    const click = async (selector, shift = false) => {
      const box = await page.evaluate(
        `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + 5, y: r.y + 5 }; })()`,
      );
      await page.cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
      for (const type of ["mousePressed", "mouseReleased"])
        await page.cdp.call("Input.dispatchMouseEvent", {
          type,
          x: box.x,
          y: box.y,
          button: "left",
          clickCount: 1,
          modifiers: shift ? 8 : 0,
        });
    };
    void ext("tab.send", { tabId, message: "picker.zap" });
    await waitFor(
      () => page.evaluate(`Boolean(document.querySelector("site-boosts-picker"))`),
      5000,
      "the picker",
    );
    await click("aside");
    await waitFor(
      async () => (await page.evaluate(hidden("aside")))[0] === true,
      5000,
      "the zapped sidebar",
    );
    void ext("tab.send", { tabId, message: "picker.zap" });
    await waitFor(
      () => page.evaluate(`Boolean(document.querySelector("site-boosts-picker"))`),
      5000,
      "the picker again",
    );
    await click("article.story h2", true);
    await waitFor(
      async () =>
        (await page.evaluate(
          `[...document.querySelectorAll("article.story h2")].every((el) => getComputedStyle(el).display === "none")`,
        )) === true,
      5000,
      "every headline like it",
    );
    const zapBoost = (await ext("boosts.list")).boosts.find((b) => b.tags.includes("zaps"));
    assert.equal(zapBoost.zaps.length, 2);
    await page.close();
  },
]);

cases.push([
  "backups and share codes bring boosts back",
  async ({ ext, fresh, host }) => {
    await fresh();
    const made = await ext("boost.create", {
      boost: {
        name: "Keep me",
        sites: [{ type: "domain", value: host }],
        css: "h1 { color: red; }",
      },
    });
    const backup = await ext("backup.export", { format: "json" });
    const zip = await ext("backup.export", { format: "zip" });
    const code = await ext("share.code", { ids: [made.id] });
    assert.match(code, /^site-boosts:/);
    await fresh();
    assert.equal((await ext("backup.import", { text: backup })).added, 1);
    await fresh();
    assert.equal((await ext("backup.import", { zip })).added, 1);
    await fresh();
    assert.equal((await ext("backup.import", { text: code })).added, 1);
    const restored = (await ext("boosts.list")).boosts;
    assert.equal(restored[0].name, "Keep me");
    assert.notEqual(restored[0].id, made.id, "shared boosts get a new identity");
  },
]);

cases.push([
  "installed scripts update from their address when a new version is out",
  async ({ ext, open, site, fresh }) => {
    await fresh();
    site.state.scriptVersion = "1.0";
    const prepared = await ext("install.prepare", { url: `${site.origin}/scripts/test.user.js` });
    const installed = await ext("install.confirm", { prepared });
    site.state.scriptVersion = "1.1";
    const results = await ext("updates.check", { apply: true });
    assert.deepEqual(
      results.map((r) => [r.from, r.to, r.applied]),
      [["1.0", "1.1", true]],
    );
    const { boost, revisions } = await ext("boost.get", { id: installed.id });
    assert.equal(boost.meta.version, "1.1");
    assert.equal(revisions[0].by, "update");
    const page = await open(`${site.origin}/news`);
    await waitFor(
      () => page.evaluate(`document.body.dataset.version === "1.1"`),
      10000,
      "the new version running",
    );
    await page.close();
  },
]);

cases.push([
  "a userstyle written in LESS is compiled, with its settings",
  async ({ ext, open, site, fresh }) => {
    await fresh();
    const source = [
      "/* ==UserStyle==",
      "@name         Less style",
      "@namespace    https://tests.example",
      "@version      1.0.0",
      "@preprocessor less",
      '@var color accent "Accent" #ff0000',
      "==/UserStyle== */",
      `@-moz-document url-prefix("${site.origin}/news") {`,
      "  @border: 4px;",
      "  #top { border-bottom: @border solid @accent; }",
      "}",
    ].join("\n");
    const prepared = await ext("install.prepare", { source });
    await ext("install.confirm", { prepared });
    const page = await open(`${site.origin}/news`);
    await waitFor(
      () =>
        page.evaluate(
          `getComputedStyle(document.getElementById("top")).borderBottom === "4px solid rgb(255, 0, 0)"`,
        ),
      5000,
      "the compiled style",
    );
    await page.close();
  },
]);

cases.push([
  "every page of the extension opens cleanly: popup, manager, editor, settings, console, setup",
  async ({ ext, open, site, chrome, fresh, host }) => {
    await fresh();
    const boost = await ext("boost.create", {
      boost: {
        name: "Editor check",
        sites: [{ type: "domain", value: host }],
        css: "h1 { color: red; }",
        js: "SB.get('x');",
      },
    });
    const news = await open(`${site.origin}/news`);
    const base = `chrome-extension://${EXTENSION_ID}`;
    const checks = [
      [`${base}/popup.html?tab=${await chrome.tabId(news)}`, /On this page[\s\S]*Editor check/],
      [`${base}/manager.html`, /Editor check/],
      [`${base}/manager.html#boost/${boost.id}/css`, /Change by talking/],
      [`${base}/manager.html#settings`, /Model[\s\S]*Site APIs[\s\S]*Backup and sharing/],
      [`${base}/manager.html#console`, /Console/],
      [`${base}/setup.html`, /Set up Site Boosts/],
    ];
    for (const [url, expected] of checks) {
      const page = await open(url);
      await waitFor(
        async () => expected.test(await page.evaluate("document.body.innerText")),
        5000,
        url,
      );
      assert.deepEqual(page.errors, [], `no errors on ${url}`);
      if (url.includes("#boost/"))
        assert.ok(
          await page.evaluate(`Boolean(document.querySelector(".cm-editor"))`),
          "the code editor",
        );
      await page.close();
    }
    await news.close();
  },
]);

test(
  "Site Boosts in real Chrome",
  {
    skip:
      !process.env.REQUIRE_E2E && !canRun
        ? "set CHROME_PATH to Chrome for Testing and run pnpm build"
        : false,
  },
  async (t) => {
    const site = await startSite();
    const chrome = await launch();
    t.after(async () => {
      await chrome.close();
      await site.close();
    });
    const { ext, open } = chrome;
    const fresh = async () => {
      for (const boost of (await ext("boosts.list")).boosts)
        await ext("boost.delete", { id: boost.id });
    };
    const context = { ext, open, site, chrome, fresh, host: "127.0.0.1" };
    for (const [name, run] of cases) await t.test(name, () => run(context));
  },
);
