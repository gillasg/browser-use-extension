import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { connect } from "node:net";
import { StaticFetcher } from "../dist/index.js";

const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

test("plain HTTP fetches go through the given proxy", async (t) => {
  const site = createServer((_req, res) => res.end("<h1>hello</h1>"));
  const sitePort = await listen(site);
  const seen = [];
  const proxy = createServer((req, res) => {
    // Plain requests in absolute form.
    seen.push(req.url);
    const upstream = new URL(req.url);
    fetch(upstream).then(async (r) => res.end(await r.text()));
  });
  proxy.on("connect", (req, socket, head) => {
    // Tunnels.
    seen.push(req.url);
    const [host, port] = req.url.split(":");
    const upstream = connect(Number(port), host, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(socket).pipe(upstream);
    });
  });
  const proxyPort = await listen(proxy);
  t.after(() => {
    site.close();
    proxy.close();
    site.closeAllConnections();
    proxy.closeAllConnections();
  });
  const fetched = await new StaticFetcher().fetch(`http://127.0.0.1:${sitePort}/`, {
    proxy: `http://127.0.0.1:${proxyPort}`,
  });
  assert.equal(fetched.status, 200);
  assert.match(fetched.body.toString(), /hello/);
  assert.ok(
    seen.some((url) => url.includes(String(sitePort))),
    "the proxy carried the request",
  );
});
