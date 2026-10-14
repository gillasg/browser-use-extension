import { styleSections, varValue } from "../shared/userscript.js";
import type { Boost } from "../shared/types.js";
import { compileLess } from "./offscreen.js";

// Userstyles written for a preprocessor are compiled when installed or when their settings
// change; plain ones get their variables at run time.

export async function compileStyle(boost: Boost): Promise<Boost> {
  const preprocessor = boost.meta?.preprocessor ?? "default";
  if (boost.kind !== "userstyle" || preprocessor === "default" || preprocessor === "uso")
    return boost;
  if (preprocessor !== "less")
    throw new Error(
      `Styles for the “${preprocessor}” preprocessor are not supported yet. Ask the author for a plain CSS or LESS version.`,
    );
  const vars = (boost.meta?.vars ?? [])
    .map((v) => `@${v.name}: ${varValue(v, boost.varValues?.[v.name]) || "~''"};`)
    .join("\n");
  const body = (boost.source ?? "").replace(
    /\/\*\s*==UserStyle==[\s\S]*?==\/UserStyle==\s*\*\//,
    "",
  );
  return { ...boost, sections: styleSections(await compileLess(`${vars}\n${body}`)) };
}
