// Test site routes for network waiting, always-on capture, failed navigation, page data, fetch
// classification and Referer/Origin headers.

const SLOW_PAGE = `<!doctype html><html><head><title>Slow</title></head><body>
<h1>Slow</h1>
<button id="load">Load</button>
<script>
  // One call while the page loads, so list() has something without start().
  fetch('/api/load');
  document.getElementById('load').onclick = function () {
    setTimeout(function () { fetch('/api/slow?from=click'); }, 150);
  };
</script></body></html>`;

// A Next-style page: the same items in __NEXT_DATA__ and in a JSON script tag, nested deeper.
const NEXT_PAGE = `<!doctype html><html><head><title>Next</title>
<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
  props: {
    pageProps: {
      items: [
        { id: 1, title: "Lamp", price: 20 },
        { id: 2, title: "Chair", price: 40 },
        { id: 3, title: "Desk", price: 90 },
      ],
    },
  },
})}</script>
<script type="application/json" id="state">${JSON.stringify({
  data: { rows: [{ id: 9, title: "Shelf" }] },
  page: 1,
})}</script>
</head><body><h1>Next</h1><div id="root"></div></body></html>`;

const PLAIN = `<!doctype html><html><head><title>Plain</title></head><body><h1>Plain</h1></body></html>`;

/** The foreign Referer and Origin /api/referer accepts (Origin loses its slash in the browser). */
export const REFERER = "https://referrer.test/page";
export const ORIGIN = "https://app.test";

export function networkRoutes(request, response) {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname === "/slow") return html(response, SLOW_PAGE);
  if (url.pathname === "/next") return html(response, NEXT_PAGE);
  if (url.pathname === "/plain") return html(response, PLAIN);
  if (url.pathname === "/api/load") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ loaded: true }));
    return true;
  }
  if (url.pathname === "/api/slow") {
    setTimeout(() => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, item: { id: 7, title: "Slow" } }));
    }, 300);
    return true;
  }
  if (url.pathname === "/api/referer") {
    // An API that checks where the call came from: only a request carrying these foreign values
    // passes, which the browser itself never sends.
    const referer = String(request.headers.referer ?? "");
    const origin = String(request.headers.origin ?? "").replace(/\/$/, "");
    if (referer !== REFERER || origin !== ORIGIN) {
      response.statusCode = 403;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ error: "wrong origin", referer, origin }));
      return true;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ referer, origin }));
    return true;
  }
  if (url.pathname === "/stall") {
    // Never answers: browser.fetch's timeout has to end it.
    return true;
  }
  return false;
}

function html(response, body) {
  response.setHeader("content-type", "text/html");
  response.end(body);
  return true;
}
