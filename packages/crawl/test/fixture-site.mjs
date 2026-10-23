// A test site for crawling: sitemaps (an index, a gzipped child, lastmod dates), a robots.txt
// that disallows everything (it is ignored), linked pages, a JavaScript-only page, a page that
// needs a session cookie, a rate-limited page, a page that changes, ETags, PDF/DOCX/XLSX files,
// a product page, a table, tracking-parameter duplicates and an infinite-scroll page.
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import ExcelJS from "exceljs";
import JSZip from "jszip";

const POSTS = 12;

function layout(title, body, extra = "") {
  return `<!doctype html><html lang="en"><head><title>${title}</title><meta name="description" content="About ${title}">${extra}</head>
<body><nav><a href="/">Home</a> <a href="/blog/">Blog</a> <a href="/docs/intro">Docs</a> <a href="/pricing">Pricing</a></nav>
<main><h1>${title}</h1>${body}</main><footer>© Test site <a href="https://elsewhere.example/">Elsewhere</a></footer></body></html>`;
}

const paragraph = (topic) =>
  `<p>${`This page explains ${topic} in detail with plenty of words about ${topic}. `.repeat(6)}</p>`;

export function minimalPdf(text) {
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}

async function docx(text) {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Quarterly memo</w:t></w:r></w:p><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

async function xlsx() {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("Prices");
  sheet.addRow(["Item", "Price"]);
  sheet.addRow(["Lamp", 25]);
  sheet.addRow(["Desk", 140]);
  return Buffer.from(await book.xlsx.writeBuffer());
}

function sitemaps(origin) {
  const urls = [
    ["/", "2026-09-01"],
    ["/pricing", "2026-09-02"],
    ["/docs/intro", "2026-01-01"],
    ["/docs/setup", "2026-01-01"],
    ...Array.from({ length: POSTS }, (_, i) => [
      `/blog/post-${i + 1}`,
      `2026-10-${String(1 + (i % 9)).padStart(2, "0")}`,
    ]),
  ];
  const child = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map(([path, lastmod]) => `<url><loc>${origin}${path}</loc><lastmod>${lastmod}</lastmod></url>`).join("")}</urlset>`;
  const index = `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${origin}/sitemap-pages.xml.gz</loc></sitemap></sitemapindex>`;
  return { child: gzipSync(child), index };
}

export async function startCrawlSite() {
  const files = {
    pdf: minimalPdf("Annual report 2026"),
    docx: await docx("Revenue grew in every region."),
    xlsx: await xlsx(),
  };
  let changing = 0;
  let flaky = 0;
  const hits = new Map();
  const state = { version: 1, hits };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const origin = `http://${req.headers.host}`;
    hits.set(url.pathname, (hits.get(url.pathname) ?? 0) + 1);
    const html = (body, status = 200, headers = {}) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
      res.end(body);
    };
    route(url, req, res, {
      origin,
      html,
      files,
      state,
      counters: { changing: () => ++changing, flaky: () => flaky++ },
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const PRODUCT = {
  "@context": "https://schema.org",
  "@type": "Product",
  name: "Desk lamp",
  sku: "LAMP-1",
  brand: { "@type": "Brand", name: "Lumo" },
  offers: {
    "@type": "Offer",
    price: "25.00",
    priceCurrency: "USD",
    availability: "https://schema.org/InStock",
  },
  aggregateRating: { ratingValue: "4.6", reviewCount: "120" },
};

const NOT_FOUND = Symbol("not found");

function discovery(url, req, res, ctx) {
  const { origin } = ctx;
  const path = url.pathname;
  if (path === "/robots.txt")
    return void (res.writeHead(200, { "content-type": "text/plain" }),
    res.end(`User-agent: *\nDisallow: /\nSitemap: ${origin}/sitemap_index.xml\n`));
  if (path === "/sitemap_index.xml")
    return void (res.writeHead(200, { "content-type": "application/xml" }),
    res.end(sitemaps(origin).index));
  if (path === "/sitemap-pages.xml.gz")
    return void (res.writeHead(200, { "content-type": "application/gzip" }),
    res.end(sitemaps(origin).child));
  return NOT_FOUND;
}

function pages(url, req, res, ctx) {
  const { html, origin } = ctx;
  const path = url.pathname;
  if (path === "/")
    return html(
      layout(
        "Home",
        `${paragraph("the home page")}<a href="/blog/">All posts</a> <a href="/product/lamp?utm_source=x">Lamp</a> <a href="/spa">App</a> <a href="/private/report">Members</a> <a href="/files/report.pdf">Report</a>`,
        `<script id="__NEXT_DATA__" type="application/json">{"buildId":"b1","props":{"pageProps":{"featured":[1,2]}}}</script>`,
      ),
    );
  if (path === "/blog/" || path === "/blog")
    return html(
      layout(
        "Blog",
        Array.from(
          { length: POSTS },
          (_, i) =>
            `<a href="/blog/post-${i + 1}">Post ${i + 1} about ${i % 2 ? "pricing plans" : "gardening"}</a>`,
        ).join(" "),
      ),
    );
  const post = /^\/blog\/post-(\d+)$/.exec(path);
  if (post) {
    const n = Number(post[1]);
    const topic = n % 2 ? "gardening tomatoes" : "pricing plans and discounts";
    const next = n < POSTS ? `<a href="/blog/post-${n + 1}">Next post</a>` : "";
    return html(
      layout(
        `Post ${n}`,
        `${paragraph(topic)}${next}`,
        n === 1 ? `<link rel="canonical" href="${origin}/blog/post-1">` : "",
      ),
    );
  }
  if (path.startsWith("/docs/"))
    return html(
      layout(
        `Docs ${path.slice(6)}`,
        `${paragraph("setting up the product")}<a href="/docs/setup">Setup</a> <a href="/docs/intro">Intro</a>`,
      ),
    );
  if (path === "/pricing")
    return html(
      layout(
        "Pricing",
        `<table><thead><tr><th>Plan</th><th>Price</th></tr></thead><tbody><tr><td>Basic</td><td>$10</td></tr><tr><td>Pro</td><td>$30</td></tr></tbody></table>${paragraph("pricing plans")}`,
      ),
    );
  if (path === "/product/lamp")
    return html(
      layout(
        "Desk lamp",
        `<div class="product"><h2 class="name">Desk lamp</h2><span class="price">$25.00</span><ul class="tags"><li>light</li><li>desk</li></ul><a class="buy" href="/cart?add=lamp">Buy</a></div>${paragraph("the desk lamp")}`,
        `<script type="application/ld+json">${JSON.stringify(PRODUCT)}</script>`,
      ),
    );
  if (path === "/spa")
    return html(
      `<!doctype html><html><head><title>App</title></head><body><div id="root"></div><script>document.getElementById('root').innerHTML = '<h1>Rendered app</h1><p>' + 'Content that only exists after JavaScript runs. '.repeat(10) + '</p>'; fetch('/api/items').then(r => r.json()).then(d => { const p = document.createElement('p'); p.id = 'items'; p.textContent = d.items.join(', '); document.body.append(p); });</script></body></html>`,
    );
  return NOT_FOUND;
}

function apps(url, req, res, ctx) {
  const { html } = ctx;
  const path = url.pathname;
  const catalog = /^\/product\/(oak-desk|office-chair|green-sofa|blue-lamp)$/.exec(path);
  if (catalog)
    return html(
      layout(
        catalog[1],
        paragraph(catalog[1]),
        `<script type="application/ld+json">${JSON.stringify({ ...PRODUCT, name: catalog[1], sku: catalog[1].toUpperCase() })}</script>`,
      ),
    );
  if (path === "/api/catalog") {
    const all = Array.from({ length: 17 }, (_, i) => ({ id: 500 + i, name: `Item ${i}` }));
    const start = parseInt(url.searchParams.get("cursor") ?? "0", 10);
    const limit = Number(url.searchParams.get("limit") ?? 5);
    const next = start + limit < all.length ? String(start + limit) + "x" : null;
    return void (res.writeHead(200, { "content-type": "application/json" }),
    res.end(JSON.stringify({ items: all.slice(start, start + limit), nextCursor: next })));
  }
  if (path === "/api/items")
    return void (res.writeHead(200, { "content-type": "application/json" }),
    res.end(JSON.stringify({ items: ["alpha", "beta", "gamma"] })));
  if (path === "/feed")
    return html(
      `<!doctype html><html><head><title>Feed</title></head><body><ul id="feed"></ul><script>let n = 0; function more() { for (let i = 0; i < 10 && n < 50; i++) { const li = document.createElement('li'); li.textContent = 'Item ' + (++n); document.getElementById('feed').append(li); } document.body.style.minHeight = (n * 200 + 2000) + 'px'; } more(); addEventListener('scroll', () => { if (innerHeight + scrollY > document.body.scrollHeight - 1500) more(); });</script></body></html>`,
    );
  return NOT_FOUND;
}

function behaviour(url, req, res, ctx) {
  const { html, state } = ctx;
  const path = url.pathname;
  if (path === "/private/report") {
    if (!/session=ok/.test(req.headers.cookie ?? ""))
      return html(
        layout("Sign in", '<form><input type="password" name="pw"></form><p>Please sign in</p>'),
        401,
      );
    return html(layout("Members report", paragraph("the members-only report")));
  }
  if (path === "/flaky")
    return ctx.counters.flaky() % 2 === 0
      ? html("slow down", 429, { "retry-after": "0" })
      : html(layout("Flaky", paragraph("eventually loading")));
  if (path === "/changing")
    return html(
      layout("Changing", `<p>Version ${state.version}</p>${paragraph("a page that changes")}`),
    );
  if (path === "/etag") {
    const tag = `"v${state.version}"`;
    if (req.headers["if-none-match"] === tag)
      return void (res.writeHead(304, { etag: tag }), res.end());
    return html(layout("Etag", `<p>Version ${state.version}</p>${paragraph("validators")}`), 200, {
      etag: tag,
    });
  }
  return NOT_FOUND;
}

function documents(url, req, res, ctx) {
  const { files } = ctx;
  const path = url.pathname;
  if (path === "/files/report.pdf")
    return void (res.writeHead(200, { "content-type": "application/pdf" }), res.end(files.pdf));
  if (path === "/files/memo.docx")
    return void (res.writeHead(200, {
      "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }),
    res.end(files.docx));
  if (path === "/files/prices.xlsx")
    return void (res.writeHead(200, {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
    res.end(files.xlsx));
  return NOT_FOUND;
}

function route(url, req, res, ctx) {
  for (const handler of [discovery, pages, apps, behaviour, documents])
    if (handler(url, req, res, ctx) !== NOT_FOUND) return;
  ctx.html(layout("Not found", "<p>Nothing here</p>"), 404);
}
