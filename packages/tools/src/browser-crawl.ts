// browser-crawl, as part of the Browser Use Extension.
//
// browser-crawl no longer depends on site-to-api: the extension is the host that has a site API,
// so it lends browser-crawl the mapped-site client here. Standalone browser-crawl simply fetches
// pages normally.
import {
  BrowserNotConnected,
  loadModel,
  siteMapper,
  siteName,
} from "@browser-use-extension/site-mapper";
import { useSiteApi } from "browser-crawl";

useSiteApi({
  siteName,
  loadModel,
  siteApi: siteMapper,
  isBrowserNotConnected: (error) => error instanceof BrowserNotConnected,
});

export * from "browser-crawl";
