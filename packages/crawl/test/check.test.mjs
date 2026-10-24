import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  AutoFetcher,
  applyRedirect,
  botCheck,
  checkSites,
  judge,
  needsBrowser,
  originGated,
  shapeOf,
} from "../dist/index.js";

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

test("redirected hosts are their own verdict; www and apex are the same site", () => {
  const base = {
    url: "https://shop.example/",
    host: "shop.example",
    via: "http",
    status: 200,
    finalUrl: "https://shop.example/",
    verdict: "ok",
  };
  assert.equal(applyRedirect(base).verdict, "ok");
  assert.equal(applyRedirect({ ...base, finalUrl: "https://www.shop.example/" }).verdict, "ok");
  const moved = applyRedirect({ ...base, finalUrl: "https://elsewhere.example/" });
  assert.equal(moved.verdict, "redirected");
  assert.match(moved.reason, /elsewhere\.example/);
});

test("origin-gated needs a plain 401/403 and a successful gated Chrome answer", () => {
  const blocked = {
    url: "https://shop.example/",
    host: "shop.example",
    via: "http",
    status: 403,
    verdict: "blocked",
  };
  assert.equal(
    originGated(blocked, { status: 200, finalUrl: blocked.url, headers: {}, html: "" }).verdict,
    "origin-gated",
  );
  assert.equal(
    originGated(blocked, { status: 403, finalUrl: blocked.url, headers: {}, html: "" }),
    undefined,
  );
  assert.equal(
    originGated(
      { ...blocked, status: 200 },
      { status: 200, finalUrl: blocked.url, headers: {}, html: "" },
    ),
    undefined,
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
      { browser: false, timeoutMs: 3000, via: "http" },
    );
    const verdicts = report.results.map((result) => result.verdict);
    assert.deepEqual(verdicts, ["ok", "refused", "dead"]);
    assert.equal(report.chromePages, 0);
    assert.equal(report.browserUsed, false);
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

test("a body's real shape is read, not its content type", () => {
  assert.equal(shapeOf("application/json", '{"a":1}'), "json-object");
  assert.equal(shapeOf("text/html", "[1,2]"), "json-array");
  assert.equal(shapeOf("text/plain", "<!doctype html><title>x</title>"), "html-page");
  assert.equal(shapeOf("application/json", "not json {"), "other");
  assert.equal(shapeOf("application/json", "   "), "empty");
});

test("check paths probe every host and compare the body's shape", async () => {
  const routes = (request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/api/x") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ id: 1, name: "Lamp" }));
      return true;
    }
    if (url.pathname === "/api/list") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify([{ id: 1 }, { id: 2 }]));
      return true;
    }
    if (url.pathname === "/stream.m3u8") {
      response.setHeader("content-type", "application/vnd.apple.mpegurl");
      response.end("#EXTM3U\n#EXT-X-VERSION:3\n");
      return true;
    }
    if (url.pathname === "/empty") {
      response.end("");
      return true;
    }
    return false;
  };
  const plain = createServer((request, response) => {
    if (routes(request, response)) return;
    response.statusCode = 404;
    response.setHeader("content-type", "text/html");
    response.end(page("<p>Not found</p>", "Not found"));
  });
  // A site whose router answers every path with the app's HTML page: nothing can be typed by path.
  const spa = createServer((request, response) => {
    if (routes(request, response)) return;
    response.setHeader("content-type", "text/html");
    response.end(page('<div id="root">App</div>'));
  });
  await new Promise((resolve) => plain.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => spa.listen(0, "127.0.0.1", resolve));
  try {
    const report = await checkSites(
      [`http://127.0.0.1:${plain.address().port}/`, `http://127.0.0.1:${spa.address().port}/`],
      {
        browser: false,
        via: "http",
        timeoutMs: 4000,
        paths: ["/api/x", "/api/list", "/stream.m3u8", "/missing", "/empty"],
        expect: "json",
      },
    );
    const [plainLine, spaLine] = report.paths;
    const probe = (line, path) => line.probes.find((item) => item.path === path);
    assert.equal(probe(plainLine, "/api/x").shape, "json-object");
    assert.equal(probe(plainLine, "/api/x").contentType, "application/json");
    assert.equal(probe(plainLine, "/api/x").ok, true);
    assert.equal(probe(plainLine, "/api/list").shape, "json-array");
    assert.equal(probe(plainLine, "/stream.m3u8").shape, "other");
    assert.match(probe(plainLine, "/stream.m3u8").reason, /expected json/);
    assert.equal(probe(plainLine, "/missing").shape, "html-page");
    assert.equal(probe(plainLine, "/empty").shape, "empty");
    // The site that answers any path with its app page: JSON is never there.
    assert.equal(probe(spaLine, "/missing").shape, "catch-all");
    assert.match(probe(spaLine, "/missing").reason, /catch-all/);
    assert.equal(probe(spaLine, "/api/x").shape, "json-object");
    assert.equal(plainLine.ok, 2);
    assert.equal(spaLine.ok, 2);
    assert.equal(spaLine.expectation, "json");
  } finally {
    plain.close();
    spa.close();
  }
});
test("check paths without expect accept any status under 400", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/ok") return response.end("fine");
    response.statusCode = 404;
    response.end("gone");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const report = await checkSites([`http://127.0.0.1:${port}/`], {
      browser: false,
      via: "http",
      paths: ["/ok", "/gone"],
    });
    const [line] = report.paths;
    assert.deepEqual(
      line.probes.map((item) => item.ok),
      [true, false],
    );
  } finally {
    server.close();
  }
});
