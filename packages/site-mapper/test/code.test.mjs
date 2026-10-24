import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { code } from "../dist/index.js";

const script = `const route = "/account/orders";\nfunction buy() { return "checkout"; }\n//# sourceMappingURL=app.js.map\n`;
const map = JSON.stringify({ sources: ["src/pages/account.tsx", "src/routes/checkout.tsx"] });
const manifest = `self.__BUILD_MANIFEST={"/":{"static/chunks/pages/index-abc.js"},"/account":["static/chunks/pages/account-def.js"]};`;

test("code reads routes, chunks, source maps, robots and sitemap", async () => {
  const server = createServer((request, response) => {
    const path = request.url ?? "/";
    if (path === "/") {
      response.setHeader("content-type", "text/html");
      response.end(
        `<title>Fixture</title><script src="/static/app.js"></script><script src="/_next/static/build/_buildManifest.js"></script>`,
      );
      return;
    }
    if (path === "/static/app.js") {
      response.setHeader("content-type", "application/javascript");
      response.end(script);
      return;
    }
    if (path === "/static/app.js.map") {
      response.setHeader("content-type", "application/json");
      response.end(map);
      return;
    }
    if (path === "/_next/static/build/_buildManifest.js") {
      response.setHeader("content-type", "application/javascript");
      response.end(manifest);
      return;
    }
    if (path === "/robots.txt") {
      response.end("User-agent: *\nSitemap: /sitemap.xml\n");
      return;
    }
    if (path === "/sitemap.xml") {
      response.setHeader("content-type", "application/xml");
      response.end(
        "<urlset><url><loc>/products/lamp</loc></url><url><loc>/about</loc></url></urlset>",
      );
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address();
  try {
    const result = await code(`http://127.0.0.1:${port}/`, { grep: "checkout" });
    assert.ok(
      result.routes.some((route) => route.route === "/account"),
      JSON.stringify(result),
    );
    assert.ok(result.files.some((file) => file.url.endsWith("/static/app.js")));
    assert.ok(result.sourceMaps.some((item) => item.sources.includes("src/pages/account.tsx")));
    assert.ok(result.robots.some((line) => line.startsWith("Sitemap:")));
    assert.deepEqual(result.sitemap, ["/products/lamp", "/about"]);
    assert.ok(
      result.matches.some(
        (match) => match.file.endsWith("/static/app.js") && match.text.includes("checkout"),
      ),
    );
  } finally {
    server.close();
  }
});
