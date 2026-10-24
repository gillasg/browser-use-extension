import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { createHostHandler, readBlockedSites, saveBlockedSites } from "../packages/tools/dist/host.js";

const PASSWORD = "host-handler-credential-secret";

async function fakeBitwarden(t) {
  const dir = await mkdtemp(join(tmpdir(), "browserkit-bw-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const outputs = join(dir, "outputs.json");
  await writeFile(
    outputs,
    JSON.stringify({
      "list items": [
        {
          id: "login-1",
          name: "Shop",
          login: {
            username: "me@example.com",
            password: PASSWORD,
            uris: [{ uri: "https://shop.example/" }],
          },
        },
      ],
    }),
  );
  const script = join(dir, "bw.mjs");
  await writeFile(
    script,
    `import { readFileSync } from "node:fs";
const outputs = JSON.parse(readFileSync(${JSON.stringify(outputs)}, "utf8"));
const args = process.argv.slice(2).join(" ");
const hit = Object.keys(outputs).find((key) => args.startsWith(key));
if (!hit) process.exit(1);
process.stdout.write(JSON.stringify(outputs[hit]));
`,
  );
  if (process.platform === "win32") await writeFile(join(dir, "bw.cmd"), `@node "${script}" %*\r\n`);
  else {
    await writeFile(join(dir, "bw"), `#!/bin/sh\nexec node "${script}" "$@"\n`);
    await chmod(join(dir, "bw"), 0o755);
  }
  return dir;
}

async function withPath(dir, work) {
  const saved = process.env.PATH;
  process.env.PATH = dir + delimiter + saved;
  try {
    return await work();
  } finally {
    process.env.PATH = saved;
  }
}

test("the one host handler answers credentials, merges site rules, and only a chat lifts a block", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "browserkit-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const previous = process.env.BROWSERKIT_HOME;
  process.env.BROWSERKIT_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.BROWSERKIT_HOME;
    else process.env.BROWSERKIT_HOME = previous;
  });
  await writeFile(
    join(home, "password-manager.json"),
    JSON.stringify({ provider: "bitwarden", bitwardenSession: "test-session" }),
  );
  await saveBlockedSites(["bank.example"], home);
  const bw = await fakeBitwarden(t);
  const rules = {
    blocked: ["extra.example"],
    only: ["only.example"],
    allow: ["lift.example"],
  };
  const extra = [];
  const handler = createHostHandler({
    dataDirectory: home,
    siteRules: () => rules,
    extra: async (request) => {
      extra.push(request);
      return { extra: true };
    },
  });

  const credential = await withPath(bw, () =>
    handler({ credential: "login", url: "https://shop.example/" }, { source: "bridge", scope: "s" }),
  );
  assert.equal(credential.logins[0]?.password, PASSWORD, "the engine gets the real login");
  assert.ok(!JSON.stringify(credential.provider).includes(PASSWORD));

  const bridgeRules = await handler(
    { siteRules: true },
    { source: "bridge", scope: "s" },
  );
  assert.deepEqual(bridgeRules, {
    blocked: ["bank.example", "extra.example"],
    only: ["only.example"],
    allow: [],
  });
  const chatRules = await handler({ siteRules: true }, { source: "chat", scope: "s" });
  assert.deepEqual(chatRules.allow, ["lift.example"], "only the chat source may lift a block");
  const routineRules = await handler({ siteRules: true }, { source: "routine", scope: "r" });
  assert.deepEqual(routineRules.allow, []);
  const externalRules = await handler({ siteRules: true }, { source: "external", scope: "e" });
  assert.deepEqual(externalRules.allow, []);

  assert.deepEqual(
    await handler({ savedRead: { url: "https://shop.example/", text: "x" } }, { source: "bridge", scope: "s" }),
    { extra: true },
  );
  assert.equal(extra.length, 1);
  const bare = createHostHandler({ dataDirectory: home });
  assert.equal(await bare({ nonsense: true }, { source: "bridge", scope: "s" }), undefined);
  assert.deepEqual(await readBlockedSites(home), ["bank.example"]);
});
