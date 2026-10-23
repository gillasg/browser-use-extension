import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import {
  buildSiteModel,
  parseCapture,
  siteApi,
  PageTransport,
  DirectTransport,
  MissingParams,
  useBrowser,
  watch,
} from "../dist/index.js";
import { startFixtureSite } from "./fixture-site.mjs";
import { browseShop, NodeRecorder, tempHome } from "./helpers.mjs";
import { FakeBrowser } from "./fake-browser.mjs";

async function shop(t, extra) {
  const site = await startFixtureSite();
  t.after(() => site.close());
  const recorder = await browseShop(site.origin);
  if (extra) await extra(recorder);
  const { model } = await buildSiteModel(parseCapture(JSON.stringify(recorder.har()), "flow"), {
    site: new URL(site.origin).host,
  });
  return { site, model };
}

test("direct calls: typed operations, query and path parameters", async (t) => {
  const { model } = await shop(t);
  const api = await siteApi(model.site, { model, transport: "direct", session: false });
  const page = await api.listProducts({ limit: 2 });
  assert.equal(page.items.length, 2);
  const product = await api.getProduct({ productId: 1005 });
  assert.equal(product.product.id, 1005);
  assert.equal((await api.getFeedNews()).headline, "Sale");
  assert.ok((await api.getFeedDeals()).deals);
});

test("missing inputs are resolved from the operations that produce them", async (t) => {
  const { model } = await shop(t);
  const api = await siteApi(model.site, { model, transport: "direct", session: false });
  const product = await api.getProduct();
  assert.equal(product.product.id, 1000, "the first id from listProducts");
  const reviews = await api.listProductsReviews();
  assert.equal(reviews.reviews.length, 3, "chained: listProducts → getProduct → reviews");
  const bare = structuredClone(model);
  bare.operations.find((o) => o.id === "getProduct").dependencies = [];
  const unresolved = await siteApi(model.site, {
    model: bare,
    transport: "direct",
    session: false,
  });
  await assert.rejects(
    () => unresolved.getProduct(),
    (error) => error instanceof MissingParams && /path:productId/.test(error.message),
  );
});

test("async iterators walk cursor and page-number pagination", async (t) => {
  const { model, site } = await shop(t);
  const api = await siteApi(model.site, { model, transport: "direct", session: false });
  const all = [];
  for await (const item of api.paginate.listProducts({ limit: 5 })) all.push(item.id);
  assert.equal(all.length, site.products.length);
  assert.equal(new Set(all).size, all.length);
  const reviews = [];
  for await (const review of api.paginate("listProductsReviews", { productId: 1000 }))
    reviews.push(review.id);
  assert.equal(reviews.length, 7);
  const capped = [];
  for await (const item of api.paginate.listProducts({ limit: 5 }, { maxItems: 7 }))
    capped.push(item);
  assert.equal(capped.length, 7);
});

test("GraphQL and JSON-RPC calls take variables and params", async (t) => {
  const { model } = await shop(t);
  const api = await siteApi(model.site, { model, transport: "direct", session: false });
  const search = await api.searchProducts({ variables: { term: "Product 2" } });
  assert.ok(search.data.search.edges.every((edge) => edge.node.name.includes("Product 2")));
  const category = await api.graphqlabc123de({ variables: { slug: "bags" } });
  assert.equal(category.data.category.name, "Category bags");
  const stock = await api.inventoryCheck({ params: { sku: "zz" } });
  assert.equal(stock.result.sku, "zz");
});

test("429s are retried with back-off", async (t) => {
  const { model } = await shop(t, async (r) => {
    await r.request("GET", "/api/flaky");
    await r.request("GET", "/api/flaky");
  });
  const api = await siteApi(model.site, { model, transport: "direct", session: false });
  const id = model.operations.find((o) => o.path === "/api/flaky").id;
  assert.deepEqual(await api.call(id), { ok: true });
});

test("in-page calls: the site's cookies apply, and its own fetch signs requests", async (t) => {
  const { model } = await shop(t);
  const browser = new FakeBrowser();
  const api = await siteApi(model.site, {
    model,
    transport: "page",
    bridge: async () => browser,
    session: false,
  });
  await assert.rejects(
    () => api.createCart({ productId: 1004, quantity: 3 }),
    /changes state; writes go through the site's page UI/,
  );
  const product = await api.getProduct({ productId: 1005 });
  assert.equal(product.product.id, 1005);
  const signed = await api.getSigned({ q: "hello" });
  assert.deepEqual(signed, { secret: "signed-ok", q: "hello" });
  const call = browser.calls.find((c) => c.url.includes("/api/signed"));
  assert.ok(call.headers["x-signature"], "signed by the page's wrapper, not by site-to-api");
});

test("auto transport: public calls go direct, signed calls go through the page", async (t) => {
  const { model } = await shop(t);
  const browser = new FakeBrowser();
  const api = await siteApi(model.site, { model, bridge: async () => browser, session: false });
  assert.equal((await api.getSigned({ q: "x" })).secret, "signed-ok");
  assert.ok(browser.calls.some((c) => c.url.includes("/api/signed")));
});

test("JSON sent with a form label is replayed as the same JSON, under the same label", async (t) => {
  const received = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    received.push({ type: request.headers["content-type"], body });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ hits: [{ title: JSON.parse(body).query }] }));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/1/indexes/items/query?key=abc`;
  const entry = (query) => ({
    startedDateTime: new Date().toISOString(),
    request: {
      method: "POST",
      url,
      headers: [{ name: "content-type", value: "application/x-www-form-urlencoded" }],
      queryString: [{ name: "key", value: "abc" }],
      postData: {
        mimeType: "application/x-www-form-urlencoded",
        text: JSON.stringify({ query, page: 0 }),
      },
    },
    response: {
      status: 200,
      headers: [{ name: "content-type", value: "application/json" }],
      content: { mimeType: "application/json", text: JSON.stringify({ hits: [{ title: query }] }) },
    },
    _resourceType: "fetch",
  });
  const har = { log: { version: "1.2", entries: [entry("rust"), entry("go")] } };
  const { model } = await buildSiteModel(parseCapture(JSON.stringify(har), "search"), {
    site: "127.0.0.1",
  });
  const operation = model.operations.find((o) => o.path === "/1/indexes/items/query");
  assert.ok(operation, model.operations.map((o) => o.path).join(", "));
  const api = await siteApi(model.site, { model, transport: "direct", session: false });
  const result = await api.call(operation.id, { query: "python", page: 0 });
  assert.equal(result.hits[0].title, "python");
  assert.match(received.at(-1).type, /x-www-form-urlencoded/);
  assert.deepEqual(JSON.parse(received.at(-1).body), { query: "python", page: 0 });
});

test("useBrowser routes every browser call through another app's connection", async (t) => {
  const { model } = await shop(t);
  const browser = new FakeBrowser();
  useBrowser(browser);
  t.after(() => useBrowser(undefined));
  const api = await siteApi(model.site, { model, session: false });
  assert.equal((await api.getSigned({ q: "y" })).secret, "signed-ok");
  assert.ok(browser.calls.some((c) => c.url.includes("/api/signed")));
});

test("direct calls with an exported session send its cookies", async (t) => {
  const { model, site } = await shop(t);
  const recorder = new NodeRecorder(site.origin);
  await recorder.request("GET", "/", { type: "document" });
  const session = {
    site: model.site,
    savedAt: new Date().toISOString(),
    cookies: [...recorder.cookies].map(([name, value]) => ({
      name,
      value,
      domain: "127.0.0.1",
      path: "/",
    })),
  };
  const transport = new DirectTransport(session);
  const response = await transport.send(
    { operationId: "x", origin: site.origin, method: "GET", url: site.origin + "/", headers: {} },
    { auth: [], home: site.origin + "/" },
  );
  assert.equal(response.status, 200);
  assert.match(
    response.text,
    /csrf-[0-9a-f]{8}/,
    "the same session, so the page shows its CSRF token",
  );
});

test("the page transport reuses PageTransport's tab code", () => {
  assert.equal(typeof new PageTransport(async () => ({})).inPage, "function");
});

test("page calls carry the sign-in header the site's own code sent, when none is recorded", async (t) => {
  const site = await startFixtureSite();
  t.after(() => site.close());
  const request = (headers) => ({
    operationId: "listProducts",
    origin: site.origin,
    method: "GET",
    url: `${site.origin}/api/products`,
    headers,
  });
  const context = { auth: [], home: `${site.origin}/` };

  const browser = new FakeBrowser();
  browser.sessionHeaders = { authorization: "Bearer live-token" };
  await new PageTransport(async () => browser).send(request({}), context);
  const sent = browser.calls.find((call) => call.url.endsWith("/api/products"));
  assert.equal(sent.headers.authorization, "Bearer live-token");

  // A header the request already has wins, and engines without the headers send none.
  const plain = new FakeBrowser();
  await new PageTransport(async () => plain).send(
    request({ authorization: "Bearer given" }),
    context,
  );
  assert.equal(
    plain.calls.find((call) => call.url.endsWith("/api/products")).headers.authorization,
    "Bearer given",
  );
  const none = new FakeBrowser();
  await new PageTransport(async () => none).send(request({}), context);
  assert.equal(
    none.calls.find((call) => call.url.endsWith("/api/products")).headers.authorization,
    undefined,
  );
});

test("watch reports only items that are new, changed or gone since the last check", async (t) => {
  await tempHome(t);
  const { model } = await shop(t);
  const options = { model, transport: "direct", session: false, name: "products" };
  const first = await watch(model.site, "listProducts", { limit: 2 }, options);
  assert.equal(first.first, true);
  assert.equal(first.total, 2);
  assert.deepEqual(first.new, []);
  const same = await watch(model.site, "listProducts", { limit: 2 }, options);
  assert.equal(same.first, false);
  assert.deepEqual([same.new.length, same.changed.length, same.removed.length], [0, 0, 0]);
  const more = await watch(model.site, "listProducts", { limit: 3 }, options);
  assert.equal(more.new.length, 1);
  assert.equal(more.new[0].id, 1002);
  const fewer = await watch(model.site, "listProducts", { limit: 2 }, options);
  assert.deepEqual(fewer.removed, ["1002"]);
  assert.equal(fewer.new.length, 0, "an item seen before is not new again");
});
