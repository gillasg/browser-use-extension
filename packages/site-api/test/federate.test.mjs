import assert from "node:assert/strict";
import test from "node:test";
import { buildSiteModel, federate, parseCapture, siteApi, SignedOut } from "../dist/index.js";
import { startFixtureSite } from "./fixture-site.mjs";
import { browseShop } from "./helpers.mjs";

// A mapped fixture site, called without a browser.
async function mapped(t) {
  const site = await startFixtureSite();
  t.after(() => site.close());
  const recorder = await browseShop(site.origin);
  const { model } = await buildSiteModel(parseCapture(JSON.stringify(recorder.har()), "flow"), {
    site: new URL(site.origin).host,
  });
  const api = await siteApi(model.site, { model, transport: "direct", session: false });
  return { site, model, api };
}

const failing = {
  call: async () => {
    throw new Error("boom");
  },
};

test("federate: one answer from several sites, with provenance and dedupe", async (t) => {
  const first = await mapped(t);
  const second = await mapped(t);
  const apis = { first: first.api, second: second.api };
  const result = await federate(
    [
      { site: first.model.site, operation: "listProducts", params: { limit: 3 }, label: "first" },
      { site: second.model.site, operation: "listProducts", params: { limit: 3 }, label: "second" },
    ],
    { keyBy: "id", client: async (target) => apis[target.label] },
  );
  assert.deepEqual(result.misses, []);
  assert.equal(result.answered.length, 2);
  assert.equal(result.items.length, 3, "both sites returned the same products");
  assert.equal(result.duplicates, 3);
  assert.deepEqual(
    result.items.map((entry) => entry.item.id),
    [1000, 1001, 1002],
  );
  assert.equal(result.items[0].site, first.model.site);
  assert.equal(result.items[0].label, "first");
  assert.equal(typeof result.items[0].elapsedMs, "number");
});

test("federate: merge builds one item from every site that had it", async (t) => {
  const first = await mapped(t);
  const second = await mapped(t);
  const apis = { first: first.api, second: second.api };
  const result = await federate(
    [
      { site: first.model.site, operation: "listProducts", params: { limit: 2 }, label: "first" },
      { site: second.model.site, operation: "listProducts", params: { limit: 2 }, label: "second" },
    ],
    {
      keyBy: "id",
      merge: (group) => ({ ...group[0].item, sources: group.map((entry) => entry.label) }),
      client: async (target) => apis[target.label],
    },
  );
  assert.equal(result.items.length, 2);
  assert.deepEqual(result.items[0].item.sources, ["first", "second"]);
});

test("federate: a broken site is a miss, never a failed answer", async (t) => {
  const first = await mapped(t);
  const result = await federate(
    [
      { site: first.model.site, operation: "listProducts", params: { limit: 2 }, label: "good" },
      { site: "broken.example", operation: "search", label: "broken" },
    ],
    {
      keyBy: "id",
      client: async (target) => (target.label === "good" ? first.api : failing),
    },
  );
  assert.equal(result.items.length, 2);
  assert.equal(result.misses.length, 1);
  assert.equal(result.misses[0].label, "broken");
  assert.equal(result.misses[0].kind, "failed");
  assert.match(result.misses[0].error, /boom/);
});

test("federate: a site that never answers is a timeout", async () => {
  const result = await federate([{ site: "slow.example", operation: "search" }], {
    timeoutMs: 40,
    client: async () => ({ call: () => new Promise(() => undefined) }),
  });
  assert.equal(result.items.length, 0);
  assert.equal(result.misses[0].kind, "timeout");
  assert.match(result.misses[0].error, /40ms/);
});

test("federate: firstWins stops starting sites once one answered with items", async (t) => {
  const first = await mapped(t);
  const result = await federate(
    [
      { site: first.model.site, operation: "listProducts", params: { limit: 2 }, label: "fast" },
      { site: "never.example", operation: "search", label: "never" },
    ],
    {
      concurrency: 1,
      firstWins: true,
      client: async (target) => (target.label === "fast" ? first.api : failing),
    },
  );
  assert.equal(result.answered.length, 1);
  assert.equal(result.misses.length, 0, "the second site was never asked");
});

test("federate: no results is an answer, not a miss", async (t) => {
  const first = await mapped(t);
  const end = Buffer.from("999").toString("base64url");
  const result = await federate(
    [{ site: first.model.site, operation: "listProducts", params: { limit: 5, cursor: end } }],
    { keyBy: "id", client: async () => first.api },
  );
  assert.equal(result.answered[0].count, 0);
  assert.deepEqual(result.misses, []);
});

test("federate: items at a pointer, keyBy as a function, and no key means no merge", async () => {
  const client = (payload) => ({ call: async () => payload });
  const pointed = await federate([{ site: "a.example", operation: "search" }], {
    items: "results.items",
    keyBy: (item) => item.id,
    client: async () => client({ results: { items: [{ id: 1 }, { id: 2 }] } }),
  });
  assert.deepEqual(
    pointed.items.map((entry) => entry.item.id),
    [1, 2],
  );
  const unkeyed = await federate(
    [
      { site: "a.example", operation: "search", label: "a" },
      { site: "b.example", operation: "search", label: "b" },
    ],
    { client: async () => client([{ id: 1 }]) },
  );
  assert.equal(unkeyed.items.length, 2, "nothing is dropped without a key");
  assert.equal(unkeyed.duplicates, 0);
});

test("federate: normalize matches keys the sites write differently", async () => {
  const payload = (title) => [{ title }];
  const result = await federate(
    [
      { site: "a.example", operation: "search", label: "a" },
      { site: "b.example", operation: "search", label: "b" },
    ],
    {
      keyBy: "title",
      normalize: (key) =>
        key
          .toLowerCase()
          .replace(/\s*\(\d{4}\)$/, "")
          .trim(),
      client: async (target) =>
        target.label === "a"
          ? { call: async () => payload("The Departed") }
          : { call: async () => payload("The Departed (2006)") },
    },
  );
  assert.equal(result.items.length, 1);
  assert.equal(result.duplicates, 1);
});

test("federate: signed out is its own miss, and a thrown string is still a message", async () => {
  const result = await federate(
    [
      { site: "a.example", operation: "search", label: "out" },
      { site: "b.example", operation: "search", label: "weird" },
    ],
    {
      client: async (target) =>
        target.label === "out"
          ? {
              call: async () => {
                throw new SignedOut("search", { status: 401, headers: {} });
              },
            }
          : {
              call: async () => {
                throw "plain string";
              },
            },
    },
  );
  assert.equal(result.misses.find((miss) => miss.label === "out").kind, "signed-out");
  assert.equal(result.misses.find((miss) => miss.label === "weird").error, "plain string");
});

test("federate: onAnswer reports each site, and concurrency is honoured", async () => {
  let inFlight = 0;
  let peak = 0;
  const seen = [];
  const result = await federate(
    Array.from({ length: 6 }, (_, index) => ({
      site: `s${index}.example`,
      operation: "search",
      label: `s${index}`,
    })),
    {
      concurrency: 2,
      onAnswer: (answer) => seen.push(answer.label),
      client: async () => ({
        call: async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 10));
          inFlight -= 1;
          return [{ id: 1 }];
        },
      }),
    },
  );
  assert.equal(result.answered.length, 6);
  assert.equal(seen.length, 6);
  assert.ok(peak <= 2, `peak concurrency was ${peak}`);
});
