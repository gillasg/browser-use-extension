// Sites that fight back: Cloudflare, DataDome, PerimeterX and friends answer a robot with a
// challenge page instead of an error. Reporting that as "broken" hides the real cause (there is
// nothing to repair), so recognise it and say which wall was hit.

import type { RuntimeResponse } from "./runtime/request.js";

export interface Challenge {
  vendor: "cloudflare" | "datadome" | "perimeterx" | "akamai" | "unknown";
  /** What gave it away, for the health report. */
  evidence: string;
}

/** Header names that only a bot wall sets. */
const HEADER_MARKERS: [string, Challenge["vendor"]][] = [
  ["cf-mitigated", "cloudflare"],
  ["x-datadome", "datadome"],
  ["x-px-block", "perimeterx"],
  ["x-akamai-transformed", "akamai"],
];

/** Page markers, checked only on a refused or unusual status so a normal page mentioning "human" is not a wall. */
const BODY_MARKERS: [RegExp, Challenge["vendor"], string][] = [
  [/_cf_chl_opt|cf-challenge|just a moment\.\.\./i, "cloudflare", "challenge page"],
  [/captcha-delivery\.com|geo\.captcha|datadome/i, "datadome", "captcha delivery"],
  [/px-captcha|_pxhd|perimeterx/i, "perimeterx", "px-captcha"],
  [/access denied[\s\S]{0,400}reference #\d/i, "akamai", "access denied"],
  [
    /verify (that )?you are (a )?human|are you a robot|checking your browser|unusual traffic/i,
    "unknown",
    "human check",
  ],
];

const WALL_STATUS = new Set([401, 403, 405, 406, 409, 429, 503]);

/** The bot wall a response came from, or undefined when it is a normal answer. */
export function detectChallenge(
  response: Pick<RuntimeResponse, "status" | "headers" | "text">,
): Challenge | undefined {
  const headers = response.headers ?? {};
  for (const [name, vendor] of HEADER_MARKERS)
    if (headers[name]) return { vendor, evidence: `${name}: ${headers[name]}` };
  if (!WALL_STATUS.has(response.status)) return undefined;
  const text = (response.text ?? "").slice(0, 60_000);
  for (const [pattern, vendor, evidence] of BODY_MARKERS)
    if (pattern.test(text)) return { vendor, evidence: `body: ${evidence}` };
  return undefined;
}
