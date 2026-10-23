import assert from "node:assert/strict";
import test from "node:test";
import { scrape, needsBrowser, extractCss, fitMarkdown } from "../dist/index.js";
import { startCrawlSite } from "./fixture-site.mjs";
import { fakeAuto, tempHome } from "./helpers.mjs";

async function site(t) {
  await tempHome(t);
  const s = await startCrawlSite();
  t.after(() => s.close());
  return s;
}

test("a page becomes main-content Markdown, links and metadata", async (t) => {
  const { origin } = await site(t);
  const { fetcher } = fakeAuto();
  const page = await scrape(`${origin}/blog/post-2`, {}, { fetcher });
  assert.equal(page.status, 200);
  assert.equal(page.fetchedBy, "static");
  assert.equal(page.title, "Post 2");
  assert.match(page.markdown, /^# Post 2/m);
  assert.doesNotMatch(page.markdown, /Elsewhere/, "footer and navigation are left out");
  assert.ok(page.links.some((link) => link.url === `${origin}/blog/post-3` && link.internal));
  assert.ok(page.links.some((link) => link.url === "https://elsewhere.example/" && !link.internal));
  assert.equal(page.metadata.description, "About Post 2");
  assert.equal(page.metadata.language, "en");
});

test("every format: whole-page Markdown, text, HTML, tables, images, page data, products", async (t) => {
  const { origin } = await site(t);
  const { fetcher } = fakeAuto();
  const formats = [
    "markdown",
    "mainMarkdown",
    "text",
    "html",
    "rawHtml",
    "tables",
    "images",
    "pageData",
    "product",
  ];
  const pricing = await scrape(
    `${origin}/pricing`,
    { formats, onlyMainContent: false, excludeTags: ["footer"] },
    { fetcher },
  );
  assert.match(pricing.markdown, /Home/, "the whole page when onlyMainContent is false");
  assert.doesNotMatch(pricing.markdown, /Elsewhere/, "excluded tags are removed");
  assert.match(pricing.markdown, /\| Plan \| Price \|/);
  assert.deepEqual(pricing.tables[0], [
    { Plan: "Basic", Price: "$10" },
    { Plan: "Pro", Price: "$30" },
  ]);
  assert.match(pricing.rawHtml, /<nav>/);
  const lamp = await scrape(`${origin}/product/lamp`, { formats }, { fetcher });
  assert.deepEqual(
    {
      name: lamp.product.name,
      price: lamp.product.price,
      currency: lamp.product.currency,
      brand: lamp.product.brand,
      availability: lamp.product.availability,
      rating: lamp.product.rating,
    },
    {
      name: "Desk lamp",
      price: 25,
      currency: "USD",
      brand: "Lumo",
      availability: "InStock",
      rating: 4.6,
    },
  );
  const home = await scrape(`${origin}/`, { formats: ["pageData"] }, { fetcher });
  assert.equal(home.pageData.next.buildId, "b1");
});

test("fitMarkdown keeps what matches the query", async (t) => {
  const { origin } = await site(t);
  const { fetcher } = fakeAuto();
  const page = await scrape(
    `${origin}/blog/post-2`,
    { formats: ["fitMarkdown"], query: "discounts" },
    { fetcher },
  );
  assert.match(page.fitMarkdown, /discounts/);
  assert.equal(
    fitMarkdown("# A\n\nabout cats and more cats\n\nabout dogs entirely", "dogs"),
    "# A\n\nabout dogs entirely",
  );
  assert.ok(page.score > 0.5);
});

test("documents: PDF, Word and Excel become Markdown", async (t) => {
  const { origin } = await site(t);
  const { fetcher } = fakeAuto();
  assert.match(
    (await scrape(`${origin}/files/report.pdf`, {}, { fetcher })).markdown,
    /Annual report 2026/,
  );
  const memo = await scrape(`${origin}/files/memo.docx`, {}, { fetcher });
  assert.match(memo.markdown, /Revenue grew in every region/);
  const prices = await scrape(`${origin}/files/prices.xlsx`, {}, { fetcher });
  assert.match(prices.markdown, /## Prices/);
  assert.match(prices.markdown, /\| Desk \| 140 \|/);
});

test("auto mode switches to the browser for pages that need JavaScript, and remembers the host", async (t) => {
  const { origin } = await site(t);
  const { fetcher, browser } = fakeAuto();
  const app = await scrape(`${origin}/spa`, { formats: ["markdown", "pageData"] }, { fetcher });
  assert.equal(app.fetchedBy, "browser");
  assert.match(app.markdown, /Rendered app/);
  assert.deepEqual(
    app.pageData.requests[0].json.items,
    ["alpha", "beta", "gamma"],
    "the JSON the page loaded itself",
  );
  const next = await scrape(`${origin}/pricing`, {}, { fetcher });
  assert.equal(next.fetchedBy, "browser", "the host needed a browser once, so it gets one");
  assert.equal(browser.calls.length, 2);
  const forced = await scrape(`${origin}/pricing`, { render: "static" }, { fetcher });
  assert.equal(forced.fetchedBy, "static");
});

test("browser-only options and formats go straight to the browser", async (t) => {
  const { origin } = await site(t);
  const { fetcher, browser } = fakeAuto();
  await scrape(`${origin}/pricing`, { scroll: "infinite" }, { fetcher });
  await scrape(`${origin}/docs/intro`, { formats: ["screenshot"] }, { fetcher });
  assert.equal(browser.calls.length, 2);
});

test("bot checks and login walls are recognised", () => {
  const response = (status, html) => ({
    status,
    contentType: "text/html",
    body: Buffer.from(html),
  });
  assert.equal(
    needsBrowser(
      response(200, `<html><body><h1>Hi</h1><p>${"real text ".repeat(50)}</p></body></html>`),
    ),
    undefined,
  );
  assert.equal(needsBrowser(response(403, "Forbidden")), "HTTP 403");
  assert.equal(
    needsBrowser(response(200, '<div id="cf-challenge-running">Checking your browser</div>')),
    "bot check",
  );
  assert.equal(
    needsBrowser(response(200, '<div id="root"></div><script src="/app.js"></script>')),
    "rendered by JavaScript",
  );
});

test("CSS schemas extract records with no model", () => {
  const html = `<ul><li class="item"><a href="/p/1">One</a><span class="price">$1,299.50</span><i>a</i><i>b</i></li><li class="item"><a href="/p/2">Two</a><span class="price">€9,99</span></li></ul>`;
  const records = extractCss(
    html,
    {
      baseSelector: ".item",
      fields: [
        { name: "name", selector: "a" },
        { name: "url", selector: "a", type: "attr", attr: "href" },
        { name: "price", selector: ".price", type: "number" },
        { name: "tags", selector: "i", type: "list" },
      ],
    },
    "https://shop.test/",
  );
  assert.deepEqual(records, [
    { name: "One", url: "https://shop.test/p/1", price: 1299.5, tags: ["a", "b"] },
    { name: "Two", url: "https://shop.test/p/2", price: 9.99, tags: [] },
  ]);
});

test("extraction runs during a scrape", async (t) => {
  const { origin } = await site(t);
  const { fetcher } = fakeAuto();
  const page = await scrape(
    `${origin}/product/lamp`,
    {
      extract: {
        css: {
          fields: [
            { name: "price", selector: ".price", type: "number" },
            { name: "tags", selector: ".tags li", type: "list" },
          ],
        },
      },
    },
    { fetcher },
  );
  assert.deepEqual(page.json, { price: 25, tags: ["light", "desk"] });
});
