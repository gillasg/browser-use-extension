import assert from "node:assert/strict";
import test from "node:test";
import { focusedWindowId } from "../packages/engine/dist/native-inventory-client.js";

const window = (windowId, focused) => ({
  windowId,
  focused,
  state: "normal",
  type: "normal",
});

test("the focused window is the one whose active tab activeTab() means", () => {
  assert.equal(focusedWindowId([window(1, false), window(2, true)]), 2);
  assert.equal(focusedWindowId([window(1, true), window(2, false)]), 1);
  assert.equal(focusedWindowId([window(1, false)]), undefined);
});
