import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { browserSitesApi } from "../packages/engine/src/code-api-sites.ts";

// The siteMapper global takes the site first or one object, everywhere.
function harness() {
  const calls = [];
  const context = vm.createContext({
    __call: async (request) => {
      calls.push(request);
      return request;
    },
    bu: { progress() {} },
    console: { log() {} },
    URL,
    Date,
    Map,
    Set,
    Object,
    Array,
    String,
    Number,
    JSON,
    Promise,
    Error,
    RegExp,
    setTimeout,
  });
  vm.runInContext(browserSitesApi, context);
  return { siteMapper: vm.runInContext("siteMapper", context), calls };
}

test("siteMapper takes a site or one object for every method", async () => {
  const { siteMapper, calls } = harness();
  const site = "shop.example";

  await siteMapper.operations(site);
  await siteMapper.operations({ site });
  await siteMapper.call(site, "listItems", { q: "lamp" });
  await siteMapper.call({ site, operation: "listItems", params: { q: "lamp" } });
  await siteMapper.undo(site, "addItem", { id: 1 });
  await siteMapper.undo({ site, operation: "addItem", params: { id: 1 } });
  await siteMapper.write(site, "removeItem", { id: 1 });
  await siteMapper.write({ site, operation: "removeItem", params: { id: 1 } });
  await siteMapper.watch(site, "listItems", { q: "lamp" });
  await siteMapper.watch({ site, operation: "listItems", params: { q: "lamp" } });
  await siteMapper.action(site, "checkout", { id: 1 });
  await siteMapper.action({ site, name: "checkout", params: { id: 1 } });
  await siteMapper.channel(site, "prices", { seconds: 2 });
  await siteMapper.channel({ site, name: "prices", params: { seconds: 2 } });
  await siteMapper.batch(site, "removeItem", [{ id: 1 }], { perSecond: 10 });
  await siteMapper.batch({ site, operation: "removeItem", items: [{ id: 1 }], perSecond: 10 });

  const expected = [
    { siteMapper: "operations", site },
    { siteMapper: "operations", site },
    { siteMapper: "call", site, operation: "listItems", params: { q: "lamp" } },
    { siteMapper: "call", site, operation: "listItems", params: { q: "lamp" } },
    { siteMapper: "undo", site, operation: "addItem", params: { id: 1 } },
    { siteMapper: "undo", site, operation: "addItem", params: { id: 1 } },
    { siteMapper: "write", site, operation: "removeItem", params: { id: 1 } },
    { siteMapper: "write", site, operation: "removeItem", params: { id: 1 } },
    { siteMapper: "watch", site, operation: "listItems", params: { q: "lamp" } },
    { siteMapper: "watch", site, operation: "listItems", params: { q: "lamp" } },
    { siteMapper: "action", site, name: "checkout", params: { id: 1 } },
    { siteMapper: "action", site, name: "checkout", params: { id: 1 } },
    { siteMapper: "channel", site, name: "prices", params: { seconds: 2 } },
    { siteMapper: "channel", site, name: "prices", params: { seconds: 2 } },
  ];
  assert.deepEqual(JSON.parse(JSON.stringify(calls.slice(0, expected.length))), expected);
  // batch writes each item through write, whichever form was used.
  const writes = calls.filter((call) => call.siteMapper === "write");
  assert.equal(writes.length, 4);
  assert.ok(writes.every((call) => call.site === site && call.operation === "removeItem"));
});
