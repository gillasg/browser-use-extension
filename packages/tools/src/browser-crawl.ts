// browser-crawl, as part of the Browser Use Extension.
//
// browser-crawl no longer depends on site-to-api: the extension is the host that has a site API,
// so it lends browser-crawl the mapped-site client here. Standalone browser-crawl simply fetches
// pages normally.
//
// Both use the same local bridge, so the extension hands it over rather than letting the crawler
// open a second connection to the same browser.
import {
  BrowserNotConnected,
  loadModel,
  sharedBridge,
  siteMapper,
  siteName,
} from "@browser-use-extension/site-mapper";
import { useBrowser, useSiteApi } from "browser-crawl";

useBrowser({
  run: async (code, options) => (await sharedBridge()).run(code, options),
  status: async () => (await sharedBridge()).status(),
  close: () => undefined,
});

useSiteApi({
  siteName,
  loadModel,
  siteApi: siteMapper,
  isBrowserNotConnected: (error) => error instanceof BrowserNotConnected,
});

export * from "browser-crawl";
