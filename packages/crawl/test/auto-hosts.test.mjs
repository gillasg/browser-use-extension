import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AutoFetcher } from "../dist/index.js";

const page = (url) => ({
  url,
  finalUrl: url,
  status: 200,
  headers: {},
  body: Buffer.from("<html><body>ok</body></html>"),
  contentType: "text/html",
  fetchedBy: "browser",
});

async function state(t) {
  const directory = await mkdtemp(join(tmpdir(), "browser-crawl-hosts-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function fetcher(directory, mode, calls) {
  return new AutoFetcher({
    stateDir: directory,
    fetchers: {
      static: {
        async fetch() {
          calls.push("static");
          throw Object.assign(new Error("socket hang up"), { cause: { code: mode } });
        },
      },
      browser: {
        async fetch(url) {
          calls.push("browser");
          return page(url);
        },
        async close() {},
      },
    },
  });
}

test("a host that refused plain HTTP goes straight to the browser after a restart", async (t) => {
  const directory = await state(t);
  const calls = [];
  await fetcher(directory, "ECONNRESET", calls).fetch("https://refused.example/", {});
  assert.deepEqual(calls, ["static", "browser"]);
  const stored = JSON.parse(await readFile(join(directory, "browser-hosts.json"), "utf8"));
  assert.equal(typeof stored["refused.example"], "number");

  const afterRestart = [];
  await fetcher(directory, "ECONNRESET", afterRestart).fetch("https://refused.example/", {});
  assert.deepEqual(afterRestart, ["browser"], "plain HTTP was skipped");
});

test("the browser-needed memory expires after 14 days", async (t) => {
  const directory = await state(t);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "browser-hosts.json"),
    JSON.stringify({ "old.example": Date.now() - 15 * 86_400_000 }),
  );
  const calls = [];
  await fetcher(directory, "ECONNRESET", calls).fetch("https://old.example/", {});
  assert.deepEqual(calls, ["static", "browser"], "an old entry is forgotten");
});

test("a DNS failure is not remembered as needing the browser", async (t) => {
  const directory = await state(t);
  const calls = [];
  await assert.rejects(
    () => fetcher(directory, "ENOTFOUND", calls).fetch("https://nope.example/", {}),
    (error) => error.cause?.code === "ENOTFOUND",
  );
  assert.deepEqual(calls, ["static"]);
  await assert.rejects(() => readFile(join(directory, "browser-hosts.json"), "utf8"));
});
