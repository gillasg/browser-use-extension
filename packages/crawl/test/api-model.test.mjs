import assert from "node:assert/strict";
import test from "node:test";
import {
  crawl,
  scrape,
  useSiteApi,
  extractJson,
  summarize,
  optionsFromPrompt,
  generateCssSchema,
  extractCss,
} from "../dist/index.js";
import { startCrawlSite } from "./fixture-site.mjs";
import { fakeAuto, tempHome } from "./helpers.mjs";

test("a mapped API adapter: every item of a paginated operation, and pages as data", async (t) => {
  await tempHome(t);
  const site = await startCrawlSite();
  t.after(() => site.close());
  const name = "shop.example";
  useSiteApi({
    siteName: () => name,
    loadModel: async () => ({
      pages: [{ id: "product", origin: site.origin, path: "/product/{slug}", extractor: "jsonld" }],
    }),
    siteApi: async () => ({
      fetchPage: async (_id, params) => ({ jsonLd: [{ name: params?.slug }] }),
      paginate: async function* () {
        for (let i = 0; i < 17; i++) yield { name: `Item ${i}` };
      },
    }),
    isBrowserNotConnected: () => false,
  });
  t.after(() => useSiteApi(undefined));
  const { fetcher } = fakeAuto();
  const items = await crawl(
    { api: { site: name, operation: "listItems" }, limit: 100 },
    { fetcher },
  );
  assert.equal(items.length, 17);
  assert.equal(items[16].json.name, "Item 16");
  assert.ok(items.every((item) => item.fetchedBy === "api"));
  const page = await scrape(
    `${site.origin}/product/blue-lamp`,
    { formats: ["markdown", "pageData"] },
    { fetcher },
  );
  assert.equal(page.fetchedBy, "api", "a mapped page endpoint answers with the page's data");
  assert.equal(page.json.jsonLd[0].name, "blue-lamp");
});

function scripted(answers) {
  const seen = [];
  return {
    seen,
    complete: async (context) => {
      seen.push(context);
      const [name, args] = answers.shift();
      return { content: [{ type: "toolCall", id: "1", name, arguments: args }] };
    },
  };
}

test("model features: JSON extraction, summaries, CSS schemas and crawl options from plain English", async (t) => {
  await tempHome(t);
  const site = await startCrawlSite();
  t.after(() => site.close());
  const model = scripted([
    ["result", { data: { name: "Desk lamp", price: 25 } }],
    ["summary", { summary: "A desk lamp for $25." }],
    [
      "schema",
      {
        baseSelector: ".product",
        fields: [
          { name: "name", selector: ".name" },
          { name: "price", selector: ".price", type: "number" },
        ],
      },
    ],
    [
      "options",
      {
        url: "https://docs.example.com",
        include: ["/api/**"],
        limit: 40,
        strategy: "best",
        query: "rate limits",
        bogus: true,
      },
    ],
  ]);
  const page = await scrape(
    `${site.origin}/product/lamp`,
    {
      formats: ["markdown", "summary"],
      extract: {
        schema: {
          type: "object",
          properties: { name: { type: "string" }, price: { type: "number" } },
        },
      },
    },
    { fetcher: fakeAuto().fetcher, model },
  );
  assert.deepEqual(page.json, { name: "Desk lamp", price: 25 });
  assert.equal(page.summary, "A desk lamp for $25.");
  assert.match(model.seen[0].messages[0].content, /Desk lamp/, "the model sees the page");
  const schema = await generateCssSchema(page.markdown, "product name and price", model);
  assert.deepEqual(
    extractCss(
      '<div class="product"><b class="name">Lamp</b><i class="price">$9</i></div>',
      schema,
      "https://x.test/",
    ),
    [{ name: "Lamp", price: 9 }],
  );
  const options = await optionsFromPrompt(
    "the API docs about rate limits on docs.example.com",
    model,
  );
  assert.deepEqual(options, {
    url: "https://docs.example.com",
    include: ["/api/**"],
    limit: 40,
    strategy: "best",
    query: "rate limits",
  });
  assert.equal(typeof extractJson, "function");
  assert.equal(typeof summarize, "function");
});
