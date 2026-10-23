// End to end in real Chrome through browserkit: rendering, the page's own JSON,
// infinite scroll, actions, screenshots and PDFs, parallel workers, and mixed crawling.
import assert from "node:assert/strict";
import test from "node:test";
import { AutoFetcher, BrowserFetcher, crawl, scrape } from "../dist/index.js";
import { startCrawlSite } from "./fixture-site.mjs";
import { browserReady, launchBrowser } from "./browser-harness.mjs";

test(
  "crawling in real Chrome",
  { skip: !process.env.REQUIRE_E2E && !browserReady, timeout: 300_000 },
  async (t) => {
    await launchBrowser(t);
    const site = await startCrawlSite();
    t.after(() => site.close());
    const browser = new BrowserFetcher(3);
    const fetcher = new AutoFetcher({ fetchers: { browser } });
    t.after(() => fetcher.close());

    await t.test(
      "JavaScript pages are rendered, with the JSON the page loaded itself",
      async () => {
        const page = await scrape(
          `${site.origin}/spa`,
          { render: "browser", waitUntil: "networkidle", formats: ["markdown", "pageData"] },
          { fetcher },
        );
        assert.equal(page.fetchedBy, "browser");
        assert.match(page.markdown, /Rendered app/);
        assert.ok(
          page.pageData.requests.some(
            (request) => request.url.endsWith("/api/items") && request.json.items.length === 3,
          ),
        );
      },
    );

    await t.test("infinite scroll, actions, screenshots and PDFs", async () => {
      const feed = await scrape(
        `${site.origin}/feed`,
        {
          scroll: "infinite",
          formats: ["markdown", "screenshot", "pdf"],
          actions: [
            {
              type: "js",
              code: "document.body.insertAdjacentHTML('beforeend', '<p>Action ran</p>')",
            },
          ],
        },
        { fetcher },
      );
      assert.match(feed.markdown, /Item 50/, "every item loaded");
      assert.match(feed.markdown, /Action ran/);
      assert.ok(feed.screenshot.startsWith("iVBOR"), "a PNG");
      assert.ok(feed.pdf.startsWith("JVBER"), "a PDF");
    });

    await t.test("a login wall is returned as is when hand-off is off", async () => {
      const page = await scrape(
        `${site.origin}/private/report`,
        { render: "browser", handoff: false },
        { fetcher },
      );
      assert.match(page.markdown, /Please sign in/);
    });

    await t.test(
      "a mixed crawl uses plain HTTP where it can and the browser where it must, in parallel",
      async () => {
        const pages = await crawl(
          {
            url: `${site.origin}/`,
            source: "links",
            maxDepth: 1,
            limit: 12,
            concurrency: 3,
            delayMs: 0,
            handoffTimeoutMs: 2000,
          },
          { fetcher: new AutoFetcher({ fetchers: { browser } }) },
        );
        const app = pages.find((page) => page.url.endsWith("/spa"));
        assert.equal(app.fetchedBy, "browser");
        assert.match(app.markdown, /Rendered app/);
        assert.ok(pages.some((page) => page.fetchedBy === "static"));
      },
    );
  },
);
