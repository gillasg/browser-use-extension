import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSiteModel,
  capabilityIndex,
  detectCapabilities,
  parseCapture,
} from "../dist/index.js";
import { startFixtureSite } from "./fixture-site.mjs";
import { browseShop } from "./helpers.mjs";

const operation = (over) => ({
  id: "op",
  method: "GET",
  origin: "https://shop.example",
  path: "/api/things",
  kind: "rest",
  params: [],
  responses: { 200: { mime: "application/json", schema: { type: "object", properties: {} } } },
  role: "read",
  security: [],
  dependencies: [],
  confidence: 0.5,
  bucket: "medium",
  flags: [],
  sampleCount: 1,
  sources: [],
  pageUrls: [],
  samples: [],
  ...over,
});

test("capabilities: roles are detected from the path, the inputs and the response", () => {
  assert.deepEqual(
    detectCapabilities(operation({ path: "/api/search", params: [{ name: "q", in: "query" }] })),
    ["search"],
  );
  assert.deepEqual(
    detectCapabilities(operation({ id: "searchProducts", path: "/graphql", method: "POST" })),
    ["search"],
  );
  assert.deepEqual(
    detectCapabilities(
      operation({
        path: "/api/products",
        pagination: { style: "cursor" },
        responses: {
          200: {
            mime: "application/json",
            schema: {
              type: "object",
              properties: { items: { type: "array", items: { type: "object" } } },
            },
          },
        },
      }),
    ),
    ["list"],
  );
  assert.deepEqual(
    detectCapabilities(
      operation({ path: "/api/products/{productId}", params: [{ name: "productId", in: "path" }] }),
    ),
    ["detail"],
  );
  assert.deepEqual(
    detectCapabilities(
      operation({
        path: "/api/products/{productId}",
        params: [{ name: "productId", in: "path" }],
        responses: {
          200: {
            mime: "application/json",
            schema: { type: "object", properties: { price: { type: "number" } } },
          },
        },
      }),
    ),
    ["detail", "price"],
  );
  assert.deepEqual(
    detectCapabilities(
      operation({
        path: "/api/showtimes",
        responses: {
          200: {
            mime: "application/json",
            schema: { type: "object", properties: { showtimes: { type: "array" } } },
          },
        },
      }),
    ),
    ["list", "availability"],
  );
  assert.deepEqual(detectCapabilities(operation({ path: "/api/telemetry" })), []);
});

test("capabilities: an app finds a role without knowing the site's operation ids", async (t) => {
  const site = await startFixtureSite();
  t.after(() => site.close());
  const recorder = await browseShop(site.origin);
  const { model } = await buildSiteModel(parseCapture(JSON.stringify(recorder.har()), "flow"), {
    site: new URL(site.origin).host,
  });
  const index = capabilityIndex(model.operations);
  assert.ok(index.search?.includes("searchProducts"), JSON.stringify(index));
  assert.ok(index.detail?.includes("getProduct"));
  assert.ok(index.list?.includes("listProducts"));
});

test("capabilities: an override wins over the guess", async (t) => {
  const site = await startFixtureSite();
  t.after(() => site.close());
  const recorder = await browseShop(site.origin);
  const { model } = await buildSiteModel(parseCapture(JSON.stringify(recorder.har()), "flow"), {
    site: new URL(site.origin).host,
    overrides: { capabilities: { getSigned: ["availability"] } },
  });
  const signed = model.operations.find((op) => op.id === "getSigned");
  assert.deepEqual(signed.capabilities, ["availability"]);
});
