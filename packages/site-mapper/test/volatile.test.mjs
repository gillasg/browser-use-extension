import assert from "node:assert/strict";
import test from "node:test";
import { volatileFields } from "../dist/index.js";

const sample = (over) => ({
  url: "https://shop.example/api/stream",
  method: "GET",
  status: 200,
  requestHeaders: {},
  responseBody: "{}",
  ...over,
});

test("volatile: the same call twice, different answer, means the value was minted", () => {
  const fields = volatileFields([
    sample({ responseBody: JSON.stringify({ title: "The Departed", ticket: "aaaa1111" }) }),
    sample({ responseBody: JSON.stringify({ title: "The Departed", ticket: "bbbb2222" }) }),
  ]);
  assert.deepEqual(fields, [{ pointer: "/ticket", reason: "changed" }]);
});

test("volatile: a different question is not evidence", () => {
  const fields = volatileFields([
    sample({ url: "https://shop.example/api/stream?q=a", responseBody: '{"ticket":"aaaa1111"}' }),
    sample({ url: "https://shop.example/api/stream?q=b", responseBody: '{"ticket":"bbbb2222"}' }),
  ]);
  assert.deepEqual(fields, []);
});

test("volatile: ticket URLs and expiry fields are marked even from one sample", () => {
  const fields = volatileFields([
    sample({
      responseBody: JSON.stringify({
        streams: [
          {
            url: "https://cdn.example/c?t=Y84wLXOn2ucp&expires=1792752873",
            quality: "1080p",
          },
        ],
        expiresAt: "2026-10-23T11:00:00Z",
      }),
    }),
  ]);
  const pointers = fields.map((field) => `${field.pointer}:${field.reason}`);
  assert.ok(pointers.includes("/streams/0/url:ticket"), pointers.join(","));
  assert.ok(pointers.includes("/expiresAt:expires"), pointers.join(","));
});

test("volatile: a stable answer is not volatile, and array items are never compared", () => {
  const body = JSON.stringify({
    items: [{ id: 1, name: "lamp" }],
    total: 1,
  });
  assert.deepEqual(
    volatileFields([sample({ responseBody: body }), sample({ responseBody: body })]),
    [],
  );
  const moving = volatileFields([
    sample({ responseBody: JSON.stringify({ items: [{ name: "lamp" }] }) }),
    sample({ responseBody: JSON.stringify({ items: [{ name: "rug" }] }) }),
  ]);
  assert.deepEqual(moving, [], "an array's contents differ by job, not by mint");
});
