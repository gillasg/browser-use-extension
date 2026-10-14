// A small site for the end-to-end tests: a news page that can be "redesigned", a shop, ads on a
// second host, userscripts and userstyles to install, and a scripted model.
import { createHash } from "node:crypto";
import { createServer } from "node:http";

const LIB = "window.__libLoaded = (window.__libLoaded || 0) + 1;";
const LIB_HASH = createHash("sha256").update(LIB).digest("hex");

function newsPage(state, adsOrigin) {
  const side = state.redesign ? "side-rail" : "sidebar";
  const stories = [
    ["Rates fall again", false],
    ["Sponsored: buy a boat", true],
    ["Local team wins", false],
    ["Sponsored: new phone", true],
  ]
    .map(
      ([title, sponsored]) =>
        `<article class="story">${sponsored ? "<span>Sponsored</span>" : ""}<h2>${title}</h2></article>`,
    )
    .join("");
  return `<!doctype html><html><head><title>News</title></head><body>
<header id="top"><h1>The Daily</h1></header>
<aside class="${side}" data-section="related">Related links</aside>
<main id="feed">${stories}</main>
<img id="pixel" src="${adsOrigin}/pixel.gif" alt="">
<script>
  setTimeout(() => {
    const banner = document.createElement("div");
    banner.id = "consent";
    banner.innerHTML = '<p>We use cookies</p><button onclick="this.parentElement.remove(); window.__accepted = true">Accept all</button>';
    document.body.append(banner);
  }, 400);
  setTimeout(() => {
    const late = document.createElement("article");
    late.className = "story";
    late.innerHTML = "<span>Sponsored</span><h2>Late ad</h2>";
    document.getElementById("feed").append(late);
  }, 700);
</script>
</body></html>`;
}

const SHOP = `<!doctype html><html><head><title>Shop</title></head><body>
<h1>Lamps</h1>
<ul id="products">
  <li class="product"><span class="name">Brass lamp</span> <span class="price">₹2,400</span></li>
  <li class="product"><span class="name">Paper lamp</span> <span class="price">₹600</span></li>
  <li class="product"><span class="name">Desk lamp</span> <span class="price">₹1,250</span></li>
</ul>
</body></html>`;

function userScript(origin, adsOrigin, version) {
  return `// ==UserScript==
// @name         Test helper
// @namespace    https://tests.example
// @version      ${version}
// @description  Exercises the userscript API
// @match        ${origin}/news*
// @require      ${origin}/scripts/lib.js#sha256=${LIB_HASH}
// @resource     greeting ${origin}/scripts/greeting.txt
// @connect      localhost
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_getResourceText
// @grant        GM_registerMenuCommand
// @grant        GM_info
// @run-at       document-end
// ==/UserScript==
const visits = GM_getValue("visits", 0) + 1;
GM_setValue("visits", visits);
GM_addStyle("#top { outline: 3px solid rgb(255, 0, 0); }");
document.body.dataset.visits = String(visits);
document.body.dataset.lib = String(window.__libLoaded);
document.body.dataset.greeting = GM_getResourceText("greeting");
document.body.dataset.handler = GM_info.scriptHandler;
document.body.dataset.version = GM_info.script.version;
GM_registerMenuCommand("Say hi", () => { document.body.dataset.menu = "clicked"; });
GM_xmlhttpRequest({
  url: "${adsOrigin}/api/price",
  responseType: "json",
  onload: (response) => { document.body.dataset.price = String(response.response.price); },
  onerror: (response) => { document.body.dataset.price = "error " + response.error; },
});
`;
}

function userStyle(origin) {
  return `/* ==UserStyle==
@name         Test style
@namespace    https://tests.example
@version      1.0.0
@preprocessor default
@var color headline "Headline colour" #0000ff
@var checkbox hideSide "Hide the sidebar" 1
==/UserStyle== */
@-moz-document url-prefix("${origin}/news") {
  h1 { color: var(--headline) !important; }
}
@-moz-document domain("unrelated.example") {
  body { display: none; }
}
`;
}

/** The scripted model: answers like a real one, based on what was asked. */
function modelAnswer(body) {
  const last = body.messages.at(-1).content;
  const request = /Request: (.*)$/s.exec(last)?.[1] ?? "";
  const site = /Page: https?:\/\/([^/:]+)/.exec(last)?.[1] ?? "127.0.0.1";
  let boost;
  let reply;
  if (/repair/i.test(request)) {
    boost = {
      name: "Hide the sidebar",
      sites: [{ type: "domain", value: site }],
      zaps: [{ selector: last.includes("side-rail") ? "aside.side-rail" : "aside.sidebar" }],
    };
    reply = "The sidebar has a new class: updated the selector.";
  } else if (/also/i.test(request)) {
    boost = {
      name: "Calmer news",
      sites: [{ type: "domain", value: site }],
      zaps: [{ selector: "aside.sidebar" }, { selector: "article.story", contains: "Sponsored" }],
    };
    reply = "Also hid sponsored stories.";
  } else if (/sidebar/i.test(request)) {
    boost = {
      name: "Calmer news",
      sites: [{ type: "domain", value: site }],
      zaps: [{ selector: "aside.sidebar" }],
    };
    reply = "Hid the sidebar.";
  } else if (/unclear/i.test(request)) {
    reply = "Which part of the page do you mean?";
    boost = null;
  }
  const text = `Here you go.\n\`\`\`json\n${JSON.stringify({ reply, boost })}\n\`\`\``;
  return { choices: [{ message: { role: "assistant", content: text } }] };
}

export async function startSite() {
  const state = { redesign: false, pixelHits: 0, modelCalls: [], scriptVersion: "1.0" };
  let origin = "";
  let adsOrigin = "";
  const json = (value) => [JSON.stringify(value), "application/json"];
  const routes = {
    "/news": () => [newsPage(state, adsOrigin)],
    "/shop": () => [SHOP],
    "/strict": () => [
      `<!doctype html><title>Strict</title><h1 id="title">Strict page</h1>`,
      "text/html",
      { "content-security-policy": "default-src 'self'; style-src 'self'; script-src 'self'" },
    ],
    "/pixel.gif": () => {
      state.pixelHits++;
      return [Buffer.from("R0lGODlhAQABAAAAACw=", "base64"), "image/gif"];
    },
    "/api/price": () => json({ price: 499 }),
    "/scripts/lib.js": () => [LIB, "text/javascript"],
    "/scripts/greeting.txt": () => ["hello from a resource", "text/plain"],
    "/scripts/test.user.js": () => [
      userScript(origin, adsOrigin, state.scriptVersion),
      "text/javascript",
    ],
    "/scripts/test.user.css": () => [userStyle(origin), "text/css"],
    "/model/v1/models": () => json({ data: [{ id: "test-model" }] }),
    "/model/v1/chat/completions": async (request) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      state.modelCalls.push(body);
      return json(modelAnswer(body));
    },
  };
  const server = createServer(async (request, response) => {
    const route = routes[new URL(request.url ?? "/", "http://x").pathname];
    const [body, type = "text/html; charset=utf-8", headers = {}] = route
      ? await route(request)
      : ["Not found", "text/plain"];
    response.writeHead(route ? 200 : 404, {
      "content-type": type,
      "access-control-allow-origin": "*",
      ...headers,
    });
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  origin = `http://127.0.0.1:${port}`;
  // The same server under another host name stands in for an ad network and other sites.
  adsOrigin = `http://localhost:${port}`;
  return { origin, adsOrigin, state, close: () => new Promise((resolve) => server.close(resolve)) };
}
