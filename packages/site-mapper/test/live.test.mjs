import assert from "node:assert/strict";
import test from "node:test";
import {
  learnLive,
  loadModel,
  NotProven,
  reversePairs,
  undoLive,
  writeKind,
  writeLive,
} from "../dist/index.js";
import { tempHome } from "./helpers.mjs";

const SITE = "videos.example";
const PAGE = "https://videos.example/playlist?list=WL";

function entry({ method = "POST", path, status = 200, body, response, step, at = 0 }) {
  return {
    startedDateTime: new Date(Date.UTC(2026, 9, 22, 10, 0, at)).toISOString(),
    _resourceType: "fetch",
    ...(step ? { _step: step } : {}),
    request: {
      method,
      url: "https://videos.example" + path,
      headers: [
        { name: "content-type", value: "application/json" },
        { name: "referer", value: PAGE },
      ],
      ...(body ? { postData: { mimeType: "application/json", text: JSON.stringify(body) } } : {}),
    },
    response: {
      status,
      headers: [{ name: "content-type", value: "application/json" }],
      content: { mimeType: "application/json", text: JSON.stringify(response) },
    },
  };
}

const listing = entry({
  method: "GET",
  path: "/api/playlist/WL/items",
  response: {
    items: [
      { videoId: "v1", setVideoId: "row-111", title: "First video" },
      { videoId: "v2", setVideoId: "row-222", title: "Second video" },
    ],
  },
  at: 1,
});
const remove = (status = 200, setVideoId = "row-111") =>
  entry({
    path: "/api/playlist/edit",
    status,
    body: { playlistId: "WL", action: "remove", setVideoId },
    response: { status: "ok", removed: setVideoId },
    step: 'click "Remove from Watch later"',
    at: 5,
  });
const har = (...entries) => ({ log: { version: "1.2", entries } });

test("a write the page made is learned, named after its control and proven", async (t) => {
  await tempHome(t);
  const result = await learnLive(SITE, har(listing, remove()));
  const learned = result.learned.find((item) => item.id === "removeFromWatchLater");
  assert.ok(learned, JSON.stringify(result.learned.map((item) => item.id)));
  assert.equal(learned.role, "action");
  assert.equal(learned.kind, "routine");
  assert.equal(learned.proven, true);
  assert.equal(learned.step, 'click "Remove from Watch later"');
  assert.match(learned.how, /siteMapper\.write\('videos\.example', 'removeFromWatchLater'/);
  assert.ok(learned.params.includes("setVideoId"));
  const model = await loadModel(SITE);
  const operation = model.operations.find((item) => item.id === "removeFromWatchLater");
  assert.deepEqual(operation.steps, ['click "Remove from Watch later"']);
  // Announced once: the same capture again teaches nothing new.
  const again = await learnLive(SITE, har(remove(200, "row-222")));
  assert.equal(
    again.learned.some((item) => item.id === "removeFromWatchLater"),
    false,
  );
});

test("unproven and consequential writes are refused before anything is sent", async (t) => {
  await tempHome(t);
  await learnLive(SITE, har(listing, remove(500)));
  await assert.rejects(
    writeLive(SITE, "removeFromWatchLater", { setVideoId: "row-222" }),
    (error) => error instanceof NotProven && /not proven yet/.test(error.message),
  );
  const order = entry({
    path: "/api/checkout/place-order",
    body: { cart: "c1" },
    response: { ok: true },
    step: 'click "Place your order"',
    at: 9,
  });
  const learned = (await learnLive(SITE, har(order))).learned[0];
  assert.equal(learned.kind, "consequential");
  assert.equal(learned.proven, undefined);
  await assert.rejects(
    writeLive(SITE, learned.id, { cart: "c1" }),
    (error) => error instanceof NotProven && /approves/.test(error.message),
  );
});

test("a proven routine write goes to the site's tab", async (t) => {
  await tempHome(t);
  await learnLive(SITE, har(listing, remove()));
  // No browser in the test: getting as far as the page transport means it was allowed.
  await assert.rejects(
    writeLive(SITE, "removeFromWatchLater", { setVideoId: "row-222" }),
    (error) => !(error instanceof NotProven),
  );
});

test("unclear writes count as consequential", () => {
  const operation = (id, steps = []) => ({ id, steps, path: "/api/x", method: "POST" });
  assert.equal(writeKind(operation("markAsRead", ['click "Mark as read"'])), "routine");
  assert.equal(writeKind(operation("sendMessage", ['click "Send"'])), "consequential");
  assert.equal(writeKind(operation("doThing", ['click "Go"'])), "consequential");
  assert.equal(writeKind(operation("removeItem"), ["removeItem"]), "consequential");
});

test("a routine write is paired with its learned opposite for Undo", () => {
  const operation = (id) => ({ id, role: "action", method: "POST", path: "/api/playlist/edit" });
  const pairs = reversePairs([
    operation("removeFromWatchLater"),
    operation("addToWatchLater"),
    operation("listPlaylist"),
  ]);
  assert.equal(pairs.removeFromWatchLater, "addToWatchLater");
  assert.equal(pairs.addToWatchLater, "removeFromWatchLater");
  assert.equal(pairs.listPlaylist, undefined);
});

test("Undo refuses a write the API never made", async (t) => {
  await tempHome(t);
  await learnLive(SITE, har(listing, remove(500)));
  await assert.rejects(
    undoLive(SITE, "removeFromWatchLater", { setVideoId: "row-111" }),
    (error) => error instanceof NotProven && /nothing to undo/.test(error.message),
  );
});

test("a search XHR that answers HTML is learned as a search operation", async (t) => {
  await tempHome(t);
  const search = {
    startedDateTime: new Date(Date.UTC(2026, 9, 22, 10, 0, 3)).toISOString(),
    _resourceType: "xhr",
    _step: 'fill "Search domains"',
    request: {
      method: "GET",
      url: "https://domains.example/domains/search?q=lamp",
      headers: [{ name: "accept", value: "text/html" }],
    },
    response: {
      status: 200,
      headers: [{ name: "content-type", value: "text/html" }],
      content: {
        mimeType: "text/html",
        text: "<ul><li>lamp.com</li><li>lamp.co</li></ul>",
      },
    },
  };
  const result = await learnLive("domains.example", har(search));
  const model = await loadModel("domains.example");
  const operation = model.operations.find((item) => item.capabilities?.includes("search"));
  assert.ok(operation, JSON.stringify(model.operations.map((item) => item.id)));
  assert.match(operation.path, /^\/domains\/search/);
  assert.equal(operation.method, "GET");
  assert.equal(operation.role, "read");
  assert.ok(operation.params.some((param) => param.name === "q"));
  assert.ok(
    result.learned.some((item) => item.id === operation.id),
    "the new search operation is announced",
  );
});
