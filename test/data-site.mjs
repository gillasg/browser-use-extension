// Test site routes for network capture, page requests, embedded data, Markdown and the tab pool.
const limitedOnce = new Set();

const ARTICLE = `<!doctype html><html lang="en"><head><title>Deals</title>
<meta name="description" content="Today's deals">
<meta property="og:title" content="Deals page">
<meta name="csrf-token" content="token-123">
<link rel="canonical" href="https://shop.example/deals">
<script type="application/ld+json">{"@type":"Product","name":"Phone","offers":{"price":"699"}}</script>
<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"items":[{"id":1,"name":"Phone"}]}}}</script>
</head><body>
<nav class="menu"><a href="/">Home</a> <a href="/about">About</a></nav>
<main><h1>Deals</h1><p>Prices from <strong>today</strong>, see <a href="/terms">terms</a>.</p>
<ul><li>Phone</li><li>Laptop</li></ul>
<table><tr><th>Item</th><th>Price</th></tr><tr><td>Phone</td><td>699</td></tr></table>
<pre>code block</pre></main>
<footer>Footer text</footer>
<script>
fetch("/api/search?q=phone", { method: "POST", headers: { "content-type": "application/json", "x-signature": "sig-1" }, body: JSON.stringify({ q: "phone", page: 1 }) });
</script>
</body></html>`;

export function dataRoutes(request, response) {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname === "/deals") {
    response.setHeader("content-type", "text/html");
    response.end(ARTICLE);
    return true;
  }
  if (url.pathname === "/api/search" || url.pathname === "/api/echo") {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      response.setHeader("set-cookie", "seen=1; Path=/");
      response.end(
        JSON.stringify({
          method: request.method,
          query: Object.fromEntries(url.searchParams),
          body: body ? JSON.parse(body) : null,
          csrf: request.headers["x-csrf-token"] ?? null,
          signature: request.headers["x-signature"] ?? null,
          results: [{ id: 1, name: "Phone" }],
        }),
      );
    });
    return true;
  }
  if (url.pathname.startsWith("/item/")) {
    const id = url.pathname.slice("/item/".length);
    if (id === "3" && !limitedOnce.has(id)) {
      limitedOnce.add(id);
      response.statusCode = 429;
      response.setHeader("content-type", "text/html");
      response.end("<title>Slow down</title>Too many requests");
      return true;
    }
    response.setHeader("content-type", "text/html");
    response.end(`<title>Item ${id}</title><h1>Item ${id}</h1>`);
    return true;
  }
  return false;
}
