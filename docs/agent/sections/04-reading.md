## Reading pages

The simplest read that works, going deeper only when it falls short: `page.data()` first (embedded
JSON: every value, no HTML parsing), then `page.table(css)`, `page.list(rowCss?)` for every row of
a list (it scrolls lists that only draw what is on screen), `page.links(css)`, `page.markdown()`,
then locators. The site's own API next; your own DOM or network code last. Never parse
`__NEXT_DATA__` or `innerText` by hand. Large scripts or responses: fetch once and keep the text in
a top-level variable, which persists between cells; never refetch them each cell.

A site used before has a `here:` line at the top of `bu.state()`: its learned API, boosts and
embedded data. Use them before clicking.
