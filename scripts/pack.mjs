// Zips build/ into site-boosts-<version>.zip, ready for the Chrome Web Store.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";

const root = fileURLToPath(new URL("../", import.meta.url));
const build = join(root, "build");

async function files(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
    ),
  );
  return nested.flat();
}

const manifest = JSON.parse(await readFile(join(build, "manifest.json"), "utf8"));
// The store assigns its own key; the development key only pins the id for local installs.
delete manifest.key;
const zip = {};
for (const file of await files(build))
  zip[relative(build, file).replaceAll("\\", "/")] = await readFile(file);
zip["manifest.json"] = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
const out = join(root, `site-boosts-${manifest.version}.zip`);
await writeFile(out, zipSync(zip, { level: 9 }));
process.stdout.write(`Packed ${out}\n`);
