import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { syncSite, startServer, toCsv, writeOutput, crawl } from "../dist/index.js";
import { startCrawlSite } from "./fixture-site.mjs";
import { fakeAuto, tempHome } from "./helpers.mjs";

async function site(t) {
  const home = await tempHome(t);
  const s = await startCrawlSite();
  t.after(() => s.close());
  return { ...s, home };
}

test("sync keeps a Markdown mirror: adds, then only what changed, then removals", async (t) => {
  const { origin, state } = await site(t);
  const dir = await mkdtemp(join(tmpdir(), "mirror-"));
  const run = (extra = {}) =>
    syncSite(
      {
        url: origin + "/docs/intro",
        source: "links",
        include: ["/docs/**", "/changing"],
        seeds: [origin + "/changing"],
        dir,
        delayMs: 0,
        ...extra,
      },
      { fetcher: fakeAuto().fetcher },
    );
  const first = await run();
  assert.equal(first.added.length, 3);
  const file = await readFile(
    join(dir, new URL(origin).host.replace(/:/g, "_"), "docs", "intro.md"),
    "utf8",
  );
  assert.match(file, /^---\nurl: /);
  assert.match(file, /# Docs intro/);
  const second = await run();
  assert.equal(second.unchanged.length, 3);
  state.version = 3;
  const third = await run();
  assert.deepEqual(
    third.changed.map((url) => new URL(url).pathname),
    ["/changing"],
  );
  const fourth = await run({ seeds: [] });
  assert.deepEqual(
    fourth.removed.map((url) => new URL(url).pathname),
    ["/changing"],
  );
});

test("exports: JSON lines, CSV and a dataset folder", async (t) => {
  const { origin } = await site(t);
  const pages = await crawl(
    { url: origin + "/docs/intro", source: "links", include: ["/docs/**"], delayMs: 0 },
    { fetcher: fakeAuto().fetcher },
  );
  const dir = await mkdtemp(join(tmpdir(), "out-"));
  await writeOutput(pages, join(dir, "pages.jsonl"));
  assert.equal((await readFile(join(dir, "pages.jsonl"), "utf8")).trim().split("\n").length, 2);
  const csv = toCsv(pages).split("\n");
  assert.equal(csv[0], "url,finalUrl,status,depth,fetchedBy,title,score,change,markdown,error");
  await writeOutput(pages, join(dir, "dataset"));
  const files = await readdir(join(dir, "dataset"));
  assert.ok(files.includes("index.json") && files.filter((f) => f.endsWith(".md")).length === 2);
});

test("the REST server runs jobs, pages results, streams events, and needs its token", async (t) => {
  const { origin } = await site(t);
  const server = await startServer({ deps: { fetcher: fakeAuto().fetcher } });
  t.after(() => server.close());
  const call = (path, init = {}) =>
    fetch(server.url + path, {
      ...init,
      headers: {
        authorization: `Bearer ${server.token}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  assert.equal((await fetch(server.url + "/v1/crawls")).status, 401);
  const started = await (
    await call("/v1/crawl", {
      method: "POST",
      body: JSON.stringify({
        url: origin + "/blog/",
        source: "links",
        limit: 6,
        delayMs: 0,
        concurrency: 1,
      }),
    })
  ).json();
  const ws = new WebSocket(`${server.url.replace("http", "ws")}/v1/crawl/${started.id}/ws`, {
    headers: { authorization: `Bearer ${server.token}` },
  });
  const live = [];
  ws.on("message", (raw) => live.push(JSON.parse(String(raw)).type));
  const sse = await call(`/v1/crawl/${started.id}/events`);
  const reader = sse.body.getReader();
  let text = "";
  while (!text.includes("event: completed"))
    text += new TextDecoder().decode((await reader.read()).value ?? new Uint8Array());
  await reader.cancel();
  const status = await (await call(`/v1/crawl/${started.id}?limit=4`)).json();
  assert.equal(status.state, "completed");
  assert.equal(status.results.length, 4);
  assert.equal(status.next, 4);
  assert.equal(status.total, 6);
  assert.ok(live.includes("page"), "WebSocket events too");
  ws.close();
  const jobs = await (await call("/v1/crawls")).json();
  assert.equal(jobs[0].id, started.id);
  const scraped = await (
    await call("/v1/scrape", {
      method: "POST",
      body: JSON.stringify({ url: origin + "/pricing", formats: ["tables"] }),
    })
  ).json();
  assert.equal(scraped.tables[0][1].Plan, "Pro");
  const mapped = await (
    await call("/v1/map", {
      method: "POST",
      body: JSON.stringify({ url: origin + "/", search: "pricing" }),
    })
  ).json();
  assert.equal(new URL(mapped[0].url).pathname, "/pricing");
});

test("MCP: scrape, map and crawl tools over stdio", async (t) => {
  const { origin, home } = await site(t);
  const child = spawn(process.execPath, [resolve("dist/cli.js"), "mcp"], {
    env: {
      ...process.env,
      BROWSER_CRAWL_HOME: home,
      BROWSER_USE_EXTENSION_HOME: home,
      SITE_TO_API_HOME: home,
    },
  });
  t.after(() => child.kill());
  let buffer = "";
  const waiting = new Map();
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let i; (i = buffer.indexOf("\n")) >= 0;) {
      const message = JSON.parse(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
      waiting.get(message.id)?.(message);
    }
  });
  let id = 0;
  const request = (method, params = {}) =>
    new Promise((done) => {
      waiting.set(++id, done);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  await request("initialize", {});
  const { result } = await request("tools/list");
  assert.deepEqual(
    result.tools.map((tool) => tool.name),
    ["scrape", "map", "crawl", "search", "find_list"],
  );
  const page = await request("tools/call", {
    name: "scrape",
    arguments: { url: origin + "/pricing", render: "static" },
  });
  assert.match(JSON.parse(page.result.content[0].text).markdown, /Basic/);
  const pages = await request("tools/call", {
    name: "crawl",
    arguments: { url: origin + "/docs/intro", limit: 2, render: "static", source: "links" },
  });
  assert.equal(JSON.parse(pages.result.content[0].text).length, 2);
});
