import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

// Packs the engine into another project's vendor directory with its source revision and checksum,
// so that project builds without this repository checked out next to it.
const destination = process.argv[2];
if (!destination) throw new Error("Usage: pnpm export:engine <vendor-directory>");
const directory = resolve(destination);
await mkdir(directory, { recursive: true });
const manifest = JSON.parse(await readFile("packages/engine/package.json", "utf8"));
const file = `browser-use-extension-engine-${manifest.version}.tgz`;
const pnpm = process.env.npm_execpath;
if (!pnpm) throw new Error("Run through pnpm export:engine.");
const packed = spawnSync(
  process.execPath,
  [pnpm, "--filter", "@browser-use-extension/engine", "pack", "--out", join(directory, file)],
  { stdio: "ignore", windowsHide: true },
);
if (packed.status !== 0) throw new Error("Packing the engine failed.");
const sha256 = createHash("sha256")
  .update(await readFile(join(directory, file)))
  .digest("hex");
const git = (...args) =>
  spawnSync("git", args, { encoding: "utf8", windowsHide: true }).stdout.trim();
await writeFile(
  join(directory, "engine-origin.json"),
  JSON.stringify(
    {
      package: manifest.name,
      version: manifest.version,
      revision: git("rev-parse", "HEAD"),
      sourceDirty: git("status", "--porcelain", "--", "packages/engine") !== "",
      file,
      sha256,
    },
    null,
    2,
  ) + "\n",
);
process.stdout.write(`Exported ${file}\n`);
