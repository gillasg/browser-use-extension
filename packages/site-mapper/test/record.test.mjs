import assert from "node:assert/strict";
import test from "node:test";
import { RecordingSession } from "../dist/index.js";
import { startFixtureSite } from "./fixture-site.mjs";
import { tempHome } from "./helpers.mjs";
import { FakeBrowser } from "./fake-browser.mjs";

/** A HAR entry with a response body big enough that a few of them beat one browser call. */
function entry(index, chars) {
  return {
    startedDateTime: new Date(1_700_000_000_000 + index).toISOString(),
    time: 10,
    _resourceType: "xhr",
    request: {
      method: "GET",
      url: `https://shop.example/api/items/${index}`,
      headers: [],
      queryString: [],
      cookies: [],
    },
    response: {
      status: 200,
      statusText: "OK",
      headers: [{ name: "content-type", value: "application/json" }],
      cookies: [],
      content: {
        mimeType: "application/json",
        text: JSON.stringify({ index, blob: "x".repeat(chars) }),
      },
    },
  };
}

test("a recording larger than one browser call is read back in pieces", async (t) => {
  await tempHome(t);
  const site = await startFixtureSite();
  t.after(() => site.close());
  // The transport refuses a result this big; the whole HAR is several times larger.
  const browser = new FakeBrowser({ maxResultChars: 1_200_000 });
  const session = await RecordingSession.start({
    url: site.origin + "/",
    bridge: async () => browser,
    foreground: false,
  });
  const entries = Array.from({ length: 40 }, (_, index) => entry(index, 120_000));
  const recorded = browser.recording.length;
  browser.recording.push(...entries);

  const recording = await session.stop();

  assert.equal(recording.har.log.entries.length, recorded + entries.length);
  assert.equal(
    recording.har.log.entries.at(-1).response.content.text.length,
    entries.at(-1).response.content.text.length,
    "every body arrives whole",
  );
});
