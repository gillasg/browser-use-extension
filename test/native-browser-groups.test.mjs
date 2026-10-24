import assert from "node:assert/strict";
import test from "node:test";
import { configureEngine } from "../packages/engine/dist/engine-config.js";
import {
  groupAgentTab,
  collapseAgentGroups,
} from "../packages/engine/dist/native-browser-groups.js";

// A tiny Chrome tab-group model: enough to prove one group per owner/window, the title marker,
// and that a lost in-memory map can find and rejoin the existing group by its marker.
const groups = new Map();
const storage = new Map();
let nextGroup = 100;
globalThis.chrome = {
  storage: {
    session: {
      get: async (key) => (storage.has(key) ? { [key]: storage.get(key) } : {}),
      set: async (values) => {
        for (const [key, value] of Object.entries(values)) storage.set(key, value);
      },
    },
  },
  tabs: {
    group: async (options) => {
      if (options.groupId !== undefined) return options.groupId;
      const id = nextGroup++;
      groups.set(id, { id, windowId: options.createProperties.windowId, title: "" });
      return id;
    },
  },
  tabGroups: {
    get: async (id) => groups.get(id),
    query: async ({ windowId }) =>
      [...groups.values()].filter((group) => group.windowId === windowId),
    update: async (id, patch) => {
      Object.assign(groups.get(id), patch);
      return groups.get(id);
    },
  },
};

configureEngine({ tabGroupTitle: (_owner, title) => title ?? "Agent" });

test("one group per chat and window, with a short chat title and a rejoin marker", async () => {
  await groupAgentTab(1, 1, "owner-one", "Trip planning for the long weekend");
  await groupAgentTab(2, 1, "owner-one", "Trip planning for the long weekend");
  assert.equal(groups.size, 1);
  const group = [...groups.values()][0];
  assert.match(group.title, /^Trip planning for the l/);
  assert.ok(group.title.includes("owner-on"));
  assert.equal(group.color, group.color.toLowerCase());

  // A new window gets its own group; the first window still has exactly one.
  await groupAgentTab(3, 2, "owner-one", "Trip planning for the long weekend");
  assert.equal(groups.size, 2);
  await collapseAgentGroups("owner-one");
  assert.ok([...groups.values()].every((item) => item.collapsed === true));
});

test("a lost owner map rejoins the existing group by the title marker", async () => {
  await groupAgentTab(5, 1, "owner-one", "Trip planning for the long weekend");
  const before = groups.size;
  storage.clear();
  const fresh = await import("../packages/engine/dist/native-browser-groups.js?lost-map");
  await fresh.groupAgentTab(4, 1, "owner-one", "Trip planning for the long weekend");
  assert.equal(groups.size, before, "no extra group was created");
  assert.equal([...groups.values()].filter((group) => group.windowId === 1).length, 1);
});
