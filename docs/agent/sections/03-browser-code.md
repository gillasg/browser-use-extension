## Browser code in one minute

`browserkit repl "<code>"` (or `browser_code`) runs JavaScript in a persistent REPL inside Chrome.
Globals: `browser`, `page`, `bu`, `siteMapper`, `google`, `skills`, `artifact`, `checkpoint`,
`help`. Variables, tabs and files persist per `--session`.

```js
const page = await browser.openTab("https://shop.example");
await bu.state(); // [id] role "name" = value, plus visible text
await bu.click(12); // act by bu id, role or visible text
await page.locator("input[name=q]").fill("lamp");
await page.getByRole("button", { name: "Search" }).click();
const rows = await page.list("tr"); // every row, scrolling lists that draw lazily
```

- One `page` per site: `browser.openTab` on a site you already have a tab for navigates it
  (`{newTab: true}` for another tab). `browser.activeTab()` is the tab the user is on;
  `browser.tabs(query?)` lists tabs, `browser.attachTab(tabId)` takes over one, `bu.use(tabId)`
  switches. Work through the user's tabs in place, all at once with `Promise.all`.
- `bu.state()` prints `[id] role "name" = value` and visible text (`*` marks changes; scope with
  `{selector}` or `{query}`). Act on apps that redraw themselves by visible text, role or bu id,
  never `document.querySelector`.
- `page` is Playwright-style: `page.goto(url)`, `page.title()`, `page.url()`, `page.locator(css)`,
  `getByRole(role, {name})`, `getByText`, `getByLabel` with `.click()`, `.fill(v)`, `.innerText()`,
  `.count()`, `.all()`, `.nth(i)`, `page.$$eval`, `page.keyboard.press("Enter")`,
  `page.waitForSelector(css)`. There is no `page.playwright`, and `page.$` is not a promise chain.
- After a cell with actions the new page state prints automatically; never add blind sleeps. A cell
  returns its last expression: end with one object holding what you found, and print only what you
  will use. Close tabs you are done with (`await page.close()`); `page.keep()` hands one to the
  user when they need it (a result, cart or form). For more than a few pages or sites use
  `browser.job(items, async (page, item) => …)`, which returns a job id and keeps running after
  the cell; check `browser.job.status(id)` or `browser.job.result(id)` later. `browser.reset()`
  closes every tab the chat opened except kept ones.
