import assert from "node:assert/strict";
import test from "node:test";
import { webTools } from "../apps/bridge/dist/web-tools.js";

test("browserkit's MCP crawl tool exposes every definition action, including check", () => {
  const crawl = webTools.find((tool) => tool.name === "crawl");
  assert.ok(crawl, "crawl tool is exposed");
  assert.ok(crawl.inputSchema.properties.action.enum.includes("check"), JSON.stringify(crawl));
});
