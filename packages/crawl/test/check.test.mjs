import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { botCheck, checkSites, judge, needsBrowser, AutoFetcher } from "../dist/index.js";

const page = (body, title = "Shop") => `<!doctype html><title>${title}</title><body>${body}</body>`;
const article = "<p>" + "Plenty of real reading text on this page. ".repeat(60) + "</p>";

test("Cloudflare's script on an ordinary page is not a bot check", () => {
  const html = page(
    `${article}<script src="/cdn-cgi/challenge-platform/h/b/scripts/jsd/abc/main.js"></script>`,
  );
  assert.equal(botCheck({ "cf-ray": "8f1-DEL", server: "cloudflare" }, html), undefined);
  const fetched = {
    status: 200,
    contentType: "text/html",
    headers: { "cf-ray": "8f1-DEL" },
    body: Buffer.from(html),
  };
  assert.equal(needsBrowser(fetched), undefined);
});

test("real challenges are named", () => {
  assert.equal(botCheck({ "cf-mitigated": "challenge" }, page("")), "Cloudflare");
  assert.equal(
    botCheck({}, page('<form id="challenge-form"></form>', "Just a moment...")),
    "Cloudflare",
  );
  assert.equal(botCheck({}, page("", "Just a moment...")), "a bot check");
  assert.equal(
    botCheck({}, page('<script src="https://geo.captcha-delivery.com/c.js"></script>')),
    "DataDome",
  );
});

test("verdicts carry their evidence", () => {
  const ok = judge({
    status: 200,
    finalUrl: "https://a.example/",
    headers: {},
    html: page(article),
  });
  assert.equal(ok.verdict, "ok");
  assert.equal(ok.title, "Shop");
  const shell = judge({
    status: 200,
    finalUrl: "https://b.example/",
    headers: {},
    html: page('<div id="root"></div><script src="/app.js"></script>'),
  });
  assert.equal(shell.verdict, "js-shell");
  assert.equal(judge({ status: 451, finalUrl: "", headers: {}, html: "" }).verdict, "blocked");
  assert.equal(
    judge({ status: 200, finalUrl: "", headers: {}, html: page("This domain is for sale") })
      .verdict,
    "parked",
  );
});

test("checkSites settles what it can over plain HTTP and marks the rest", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/reset") return request.socket.destroy();
    response.setHeader("content-type", "text/html");
    response.end(page(article));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const report = await checkSites(
      [`http://127.0.0.1:${port}/`, `http://127.0.0.1:${port}/reset`, "no-such-host.invalid"],
      { browser: false, timeoutMs: 3000 },
    );
    const verdicts = report.results.map((result) => result.verdict);
    assert.deepEqual(verdicts, ["ok", "refused", "dead"]);
    assert.match(report.results[1].reason, /not checked in Chrome/);
  } finally {
    server.close();
  }
});

test("a refused connection goes to the browser instead of failing the page", async () => {
  const browser = {
    name: "browser",
    fetch: async (url) => ({
      url,
      finalUrl: url,
      status: 200,
      headers: {},
      contentType: "text/html",
      body: Buffer.from(page(article)),
      fetchedBy: "browser",
    }),
  };
  const reset = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
  const fetcher = new AutoFetcher({
    fetchers: {
      static: {
        name: "static",
        fetch: async () => {
          throw reset;
        },
      },
      browser,
      api: { name: "api", endpoint: async () => undefined, fetch: async () => undefined },
    },
  });
  const fetched = await fetcher.fetch("https://refuses.example/", { formats: ["markdown"] });
  assert.equal(fetched.fetchedBy, "browser");
});
