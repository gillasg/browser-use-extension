// A two-step sign-in (email, then password, then a one-time code) and a fake `bw` CLI holding
// its login, for the password-manager sign-in test.
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const LOGIN = { username: "me@example.com", password: "hunter2-Secret!", code: "246810" };

const page = (title, body) =>
  `<!doctype html><title>${title}</title><main><h1>${title}</h1>${body}</main>`;

export function loginRoutes(request, response) {
  const url = new URL(request.url ?? "/", "http://x");
  if (!url.pathname.startsWith("/login") && url.pathname !== "/account") return false;
  response.setHeader("content-type", "text/html");
  if (url.pathname === "/login")
    response.end(
      page(
        "Sign in",
        `<form action="/login/password"><label>Email <input name="email" type="email" autocomplete="username"></label><button type="submit">Next</button></form>`,
      ),
    );
  else if (url.pathname === "/login/password") {
    const error = url.searchParams.get("error") ? "<p>Wrong password</p>" : "";
    response.end(
      page(
        "Password",
        `${error}<form action="/login/check"><input type="hidden" name="email" value="${url.searchParams.get("email") ?? ""}"><label>Password <input name="password" type="password" autocomplete="current-password"></label><button type="submit">Sign in</button></form>`,
      ),
    );
  } else if (url.pathname === "/login/check") {
    const ok =
      url.searchParams.get("email") === LOGIN.username &&
      url.searchParams.get("password") === LOGIN.password;
    response.statusCode = 302;
    response.setHeader("location", ok ? "/login/code" : "/login/password?error=1");
    response.end();
  } else if (url.pathname === "/login/code")
    response.end(
      page(
        "Verify",
        `<form action="/login/verify"><label>Code <input name="otp" inputmode="numeric" autocomplete="one-time-code"></label><button type="submit">Verify</button></form>`,
      ),
    );
  else if (url.pathname === "/login/verify") {
    response.statusCode = 302;
    response.setHeader(
      "location",
      url.searchParams.get("otp") === LOGIN.code ? "/account" : "/login/code",
    );
    response.end();
  } else response.end(page("Account", `<p>Signed in as ${LOGIN.username}</p>`));
  return true;
}

/** A directory holding a `bw` that answers like an unlocked Bitwarden vault. */
export async function fakeBitwarden(host) {
  const dir = await mkdtemp(join(tmpdir(), "fake-bw-"));
  const items = [
    {
      id: "item-1",
      name: "Test site",
      login: {
        username: LOGIN.username,
        password: LOGIN.password,
        totp: "otpauth://totp/x",
        uris: [{ uri: `http://${host}/login` }],
      },
    },
  ];
  const script = join(dir, "bw.mjs");
  await writeFile(
    script,
    `const args = process.argv.slice(2);
if (args[0] === "status") process.stdout.write(JSON.stringify({ status: "unlocked" }));
else if (args[0] === "list") process.stdout.write(${JSON.stringify(JSON.stringify(items))});
else if (args[0] === "get" && args[1] === "totp") process.stdout.write(${JSON.stringify(LOGIN.code)});
else process.exit(1);
`,
  );
  if (process.platform === "win32")
    await writeFile(join(dir, "bw.cmd"), `@node "${script}" %*\r\n`);
  else {
    await writeFile(join(dir, "bw"), `#!/bin/sh\nexec node "${script}" "$@"\n`);
    await chmod(join(dir, "bw"), 0o755);
  }
  return dir;
}
