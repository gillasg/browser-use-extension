import assert from "node:assert/strict";
import test from "node:test";
import { unsplitForClose } from "../packages/engine/dist/native-browser-tab-cleanup.js";

test("closing a Split View tab unsplits its split first", async () => {
  const calls = [];
  await unsplitForClose({ id: 7, splitViewId: 41 }, 7, { unsplit: async (id) => calls.push(id) });
  assert.deepEqual(calls, [41]);
});

test("closing a tab that is not split does not call unsplit", async () => {
  const calls = [];
  await unsplitForClose({ id: 7, splitViewId: -1 }, 7, { unsplit: async (id) => calls.push(id) });
  assert.deepEqual(calls, []);
});
