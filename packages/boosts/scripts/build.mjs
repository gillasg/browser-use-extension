// Builds the unpacked extension into build/, and the pure modules for the tests into build-test/.
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = join(root, "build");
const src = (path) => join(root, "src", path);
const common = {
  bundle: true,
  platform: "browser",
  target: "chrome135",
  logLevel: "warning",
  legalComments: "none",
};

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

// The runtime every script gets is built first: the service worker carries it as a string.
const runtime = await build({
  ...common,
  entryPoints: [src("runtime/index.ts")],
  format: "iife",
  globalName: "__sbRuntime",
  minify: true,
  write: false,
});
const runtimeCode = runtime.outputFiles[0].text;

const entries = {
  "background.js": "background/index.ts",
  "content.js": "content/index.ts",
  "popup.js": "pages/popup.ts",
  "manager.js": "pages/manager/index.ts",
  "install.js": "pages/install.ts",
  "setup.js": "pages/setup.ts",
  "offscreen.js": "pages/offscreen.ts",
};
await Promise.all(
  Object.entries(entries).map(([file, entry]) =>
    build({
      ...common,
      entryPoints: [src(entry)],
      outfile: join(out, file),
      format: "iife",
      define: { __GM_RUNTIME__: JSON.stringify(runtimeCode) },
    }),
  ),
);

const copies = [
  "pages/popup.html",
  "pages/manager.html",
  "pages/install.html",
  "pages/setup.html",
  "pages/offscreen.html",
  "pages/common.css",
];
await Promise.all(copies.map((file) => copyFile(src(file), join(out, file.split("/").pop()))));
await Promise.all(
  [16, 32, 48, 128].map((size) =>
    copyFile(join(root, `assets/icon-${size}.png`), join(out, `icon-${size}.png`)),
  ),
);
const manifest = JSON.parse(await readFile(src("manifest.json"), "utf8"));
manifest.version = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
await writeFile(join(out, "manifest.json"), JSON.stringify(manifest, null, 2));

// Pure modules (no chrome.* at import time) for the unit tests.
await build({
  ...common,
  entryPoints: [src("testing.ts")],
  outfile: join(root, "build-test/lib.mjs"),
  format: "esm",
  platform: "node",
  target: "node22",
});
process.stdout.write(`Built the extension at ${out}\n`);
