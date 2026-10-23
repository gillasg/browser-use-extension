import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import {
  handleCredentialRequest,
  hostOf,
  isCredentialRequest,
  loginsFor,
  sameSite,
  saveConfig,
} from "../dist/index.js";

const login = (urls, username = "me@example.com", extra = {}) => ({
  id: "1",
  name: "Example",
  username,
  password: "secret",
  hasTotp: false,
  urls,
  ...extra,
});

test("a saved login matches its own site and subdomains, never a look-alike", () => {
  assert.equal(hostOf("https://www.Example.com/login"), "example.com");
  assert.equal(hostOf("example.com"), "example.com");
  assert.equal(hostOf("javascript:alert(1)"), undefined);
  assert.ok(sameSite("example.com", "accounts.example.com"));
  assert.ok(!sameSite("example.com", "example.com.evil.io"));
  assert.ok(!sameSite("example.com", "notexample.com"));
  const saved = [login(["https://example.com"]), login(["evil.io"], "x")];
  assert.deepEqual(
    loginsFor(saved, "accounts.example.com").map((l) => l.username),
    ["me@example.com"],
  );
  // A look-alike host only gets logins saved for the look-alike itself.
  assert.deepEqual(
    loginsFor(saved, "example.com.evil.io").map((l) => l.username),
    ["x"],
  );
  assert.equal(loginsFor(saved, "example.com", "someone-else").length, 0);
  assert.equal(loginsFor([login(["example.com"], "u", { password: "" })], "example.com").length, 0);
});

test("only login and totp requests with a url are credential requests", () => {
  assert.ok(isCredentialRequest({ credential: "login", url: "https://a.com" }));
  assert.ok(!isCredentialRequest({ credential: "dump", url: "https://a.com" }));
  assert.ok(!isCredentialRequest({ credential: "login" }));
});

async function fakeTool(name, outputs) {
  const dir = await mkdtemp(join(tmpdir(), "credentials-"));
  const data = join(dir, "outputs.json");
  await writeFile(data, JSON.stringify(outputs));
  const script = join(dir, name + ".mjs");
  await writeFile(
    script,
    `import { readFileSync } from "node:fs";
const outputs = JSON.parse(readFileSync(${JSON.stringify(data)}, "utf8"));
const args = process.argv.slice(2).join(" ");
const hit = Object.keys(outputs).find((key) => args.startsWith(key));
if (!hit) { process.stderr.write("unknown " + args); process.exit(1); }
process.stdout.write(typeof outputs[hit] === "string" ? outputs[hit] : JSON.stringify(outputs[hit]));
`,
  );
  if (process.platform === "win32")
    await writeFile(join(dir, name + ".cmd"), `@node "${script}" %*\r\n`);
  else {
    await writeFile(join(dir, name), `#!/bin/sh\nexec node "${script}" "$@"\n`);
    await chmod(join(dir, name), 0o755);
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

test("Bitwarden: logins for the page, then a fresh one-time code", async () => {
  const dir = await fakeTool("bw", {
    status: { status: "unlocked" },
    "list items": [
      {
        id: "a1",
        name: "Airtel",
        login: {
          username: "me@example.com",
          password: "hunter2",
          totp: "otpauth://x",
          uris: [{ uri: "https://www.airtel.in/" }],
        },
      },
      { id: "b2", name: "Note", type: 2 },
    ],
    "get totp a1": "123456\n",
  });
  const config = await mkdtemp(join(tmpdir(), "credentials-config-"));
  await saveConfig(config, { provider: "bitwarden", bitwardenSession: "abc" });
  await withPath(dir, async () => {
    const answer = await handleCredentialRequest(
      { credential: "login", url: "https://airtel.in/login" },
      config,
    );
    assert.equal(answer.provider, "Bitwarden");
    assert.deepEqual(answer.logins, [
      { id: "a1", name: "Airtel", username: "me@example.com", password: "hunter2", hasTotp: true },
    ]);
    const code = await handleCredentialRequest(
      { credential: "totp", url: "https://airtel.in", id: "a1" },
      config,
    );
    assert.deepEqual(code, { code: "123456" });
    const foreign = await handleCredentialRequest(
      { credential: "totp", url: "https://evil.io", id: "a1" },
      config,
    );
    assert.deepEqual(foreign, { code: null });
  });
});

test("Proton Pass: reads logins wherever its JSON keeps them", async () => {
  const dir = await fakeTool("pass-cli", {
    "vault list": [{ name: "Personal", share_id: "S1" }],
    "item list --share-id S1": {
      items: [
        {
          item_id: "I1",
          share_id: "S1",
          title: "GitHub",
          content: { content: { username: "me", password: "pw", urls: ["https://github.com"] } },
        },
      ],
    },
    "item totp pass://S1/I1": { totp: "654321" },
  });
  const config = await mkdtemp(join(tmpdir(), "credentials-config-"));
  await saveConfig(config, { provider: "proton" });
  await withPath(dir, async () => {
    const answer = await handleCredentialRequest(
      { credential: "login", url: "https://github.com/login" },
      config,
    );
    assert.equal(answer.provider, "Proton Pass");
    assert.equal(answer.logins[0]?.password, "pw");
    assert.equal(answer.logins[0]?.id, "pass://S1/I1");
  });
});

test("no password manager set up: says so instead of failing", async () => {
  const config = await mkdtemp(join(tmpdir(), "credentials-config-"));
  const empty = await mkdtemp(join(tmpdir(), "credentials-empty-"));
  const saved = process.env.PATH;
  process.env.PATH = empty;
  try {
    const answer = await handleCredentialRequest(
      { credential: "login", url: "https://example.com" },
      config,
    );
    assert.equal(answer.error, "NO_PASSWORD_MANAGER");
  } finally {
    process.env.PATH = saved;
  }
});
