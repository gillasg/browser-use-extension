import { copyFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { boostEngineDefine, writeBoostContent } from "@browser-use-extension/engine/boosts-build";

// Builds the unpacked extension into apps/extension/build.
const root = fileURLToPath(new URL("../", import.meta.url));
const engine = fileURLToPath(new URL("../../../packages/engine/", import.meta.url));
const output = join(root, "build");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const entries = [
  [join(root, "src/service-worker.ts"), "service-worker.js"],
  [join(root, "src/popup.ts"), "popup.js"],
  [join(engine, "src/code-offscreen.ts"), "code-offscreen.js"],
  [join(engine, "src/code-sandbox.ts"), "code-sandbox.js"],
];
// The service worker carries the boost engine; its content script is built beside it.
const boosts = await boostEngineDefine();
await writeBoostContent(join(output, "boosts-content.js"));
await Promise.all(
  entries.map(([entry, file]) =>
    build({
      ...(file === "service-worker.js" ? { define: boosts } : {}),
      entryPoints: [entry],
      outfile: join(output, file),
      bundle: true,
      platform: "browser",
      format: "iife",
      target: "chrome116",
      logLevel: "warning",
    }),
  ),
);
const copies = [
  [join(root, "manifest.json"), "manifest.json"],
  [join(root, "popup.html"), "popup.html"],
  [join(engine, "assets/code-offscreen.html"), "code-offscreen.html"],
  [join(engine, "assets/code-sandbox.html"), "code-sandbox.html"],
  ...[16, 32, 48, 128].map((size) => [join(root, `assets/icon-${size}.png`), `icon-${size}.png`]),
];
await Promise.all(copies.map(([from, to]) => copyFile(from, join(output, to))));
process.stdout.write(`Built the extension at ${output}\n`);
