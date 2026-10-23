// For extensions that embed the boost engine (site-boosts/embed) in their own build:
//   define: { ...(await boostEngineDefine()) }   on the service-worker build
//   await writeBoostContent(join(out, "boosts-content.js"))
// and startBoostEngine({ contentScript: "boosts-content.js" }) in the service worker.
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const src = (path) => fileURLToPath(new URL(`../src/${path}`, import.meta.url));
const common = {
  bundle: true,
  platform: "browser",
  target: "chrome135",
  logLevel: "warning",
  legalComments: "none",
  format: "iife",
};

/** The runtime every boost script gets, which the service worker registers with each script. */
export async function boostEngineDefine() {
  const runtime = await build({
    ...common,
    entryPoints: [src("runtime/index.ts")],
    globalName: "__sbRuntime",
    minify: true,
    write: false,
  });
  return { __GM_RUNTIME__: JSON.stringify(runtime.outputFiles[0].text) };
}

/** Builds the engine's content script to the given file. */
export async function writeBoostContent(outfile) {
  await build({ ...common, entryPoints: [src("embed/content.ts")], outfile });
}
