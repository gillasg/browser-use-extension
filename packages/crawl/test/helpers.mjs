import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutoFetcher, StaticFetcher } from "../dist/index.js";

/** Private homes for the crawler, site-to-api and the bridge, so tests touch nothing real. */
export async function tempHome(t) {
  const dir = await mkdtemp(join(tmpdir(), "browser-crawl-"));
  const keys = ["BROWSER_CRAWL_HOME", "SITE_TO_API_HOME", "BROWSER_USE_EXTENSION_HOME"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) process.env[key] = dir;
  t.after(async () => {
    for (const key of keys)
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

/** Stands in for the user's browser: runs the one script the fixture's app page needs. */
export class FakeBrowserFetcher {
  name = "browser";
  calls = [];

  async fetch(url, options) {
    this.calls.push({ url, options });
    const fetched = await new StaticFetcher().fetch(url, options);
    let html = fetched.body.toString("utf8");
    if (new URL(url).pathname === "/spa")
      html = html.replace(
        '<div id="root"></div>',
        `<div id="root"><h1>Rendered app</h1><p>${"Content that only exists after JavaScript runs. ".repeat(10)}</p></div><p id="items">alpha, beta, gamma</p>`,
      );
    return {
      ...fetched,
      fetchedBy: "browser",
      html,
      body: Buffer.from(html),
      contentType: "text/html",
      pageData: {
        requests: [
          {
            url: new URL("/api/items", url).href,
            method: "GET",
            json: { items: ["alpha", "beta", "gamma"] },
          },
        ],
      },
    };
  }

  async close() {}
}

export function fakeAuto() {
  const browser = new FakeBrowserFetcher();
  return { fetcher: new AutoFetcher({ fetchers: { browser } }), browser };
}
