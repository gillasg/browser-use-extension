## Which way to do it

- **Act on a page** (click, fill, submit, read what is on screen): browser control. `browserkit repl`
  or the `browser_code` MCP tool.
- **Read a lot of pages** (a page, a section, a whole site, a sitemap, search results): `crawl`,
  `scrape`, `map-urls`, `search`. Plain HTTP first, the browser only when a page needs it. Much
  cheaper than driving each page.
- **Call a site's API**: only if the site is mapped (`browserkit sites`). One call replaces many
  page actions and returns JSON with the user's session. If it is not mapped, map it (`map`,
  `describe`, `learn`) or just use the page.
- **A site used repeatedly**, where the answer must keep coming: map it, then `call`, `watch`,
  `federate` (several sites at once, with provenance).
- **What the user visited, saved or has open**: their history, bookmarks and open tabs, not a
  search engine. A site, page or thing they name without a link: look in those three together
  before guessing from memory.
- **Anything live or on a specific site** (prices, stock, listings, showtimes, reviews): open that
  site in the browser. Web search only finds which page to open.
