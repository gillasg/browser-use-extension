// Whether a response is a bot check in front of the page, and whose. Only real challenge signals
// count: the challenge header, the challenge form or its options, or an interstitial's title.
// Cloudflare loads `/cdn-cgi/challenge-platform/…` scripts into ordinary pages and sends `cf-ray`
// on every response; neither means the page is blocked.

const HEADER_SIGNALS: ReadonlyArray<[string, RegExp, string]> = [
  ["cf-mitigated", /challenge/i, "Cloudflare"],
  ["x-datadome", /./, "DataDome"],
];

const BODY_SIGNALS: ReadonlyArray<[RegExp, string]> = [
  [
    /_cf_chl_opt|id="challenge-form"|cf-challenge-running|class="cf-challenge|cf-please-wait|cf-turnstile-wrapper/i,
    "Cloudflare",
  ],
  [/captcha-delivery\.com|geo\.captcha-delivery/i, "DataDome"],
  [/px-captcha|_pxCaptcha|perimeterx/i, "PerimeterX"],
  [/_Incapsula_Resource|incap_ses_/i, "Imperva"],
  [/ddos-guard\.net\/(?:check|js)/i, "DDoS-Guard"],
  [/sucuri_cloudproxy_js|sucuri website firewall/i, "Sucuri"],
  [/checking your browser before|enable javascript and cookies to continue/i, "a bot check"],
];

const TITLE_SIGNAL =
  /^\s*(just a moment\.\.\.|attention required!? \| cloudflare|verifying you are human|checking your browser|ddos-guard|access denied|one more step)\s*$/i;

/** The vendor whose bot check this response is, or undefined for an ordinary page. */
export function botCheck(headers: Record<string, string>, html: string): string | undefined {
  const lower = Object.fromEntries(
    Object.entries(headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  for (const [name, pattern, vendor] of HEADER_SIGNALS) {
    const value = lower[name];
    if (value && pattern.test(value)) return vendor;
  }
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1];
  for (const [pattern, vendor] of BODY_SIGNALS)
    if (pattern.test(html) && !looksLikeContent(html)) return vendor;
  if (title && TITLE_SIGNAL.test(title))
    return /ddos-guard/i.test(title) ? "DDoS-Guard" : "a bot check";
  return undefined;
}

/** A page with real reading text: an embedded widget is not a wall in front of it. */
function looksLikeContent(html: string): boolean {
  const text = html
    .replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 1500;
}

/** A request that failed below HTTP (reset, TLS refusal, timeout): a real browser may still get in. */
export function isNetworkRefusal(error: unknown): boolean {
  const text =
    String((error as { cause?: { code?: string } })?.cause?.code ?? "") + " " + String(error);
  return /ECONNRESET|EPROTO|ERR_SSL|UND_ERR_SOCKET|ECONNREFUSED|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|TimeoutError|aborted|fetch failed|socket hang up|other side closed/i.test(
    text,
  );
}

/** The name did not resolve: no browser can reach it either. */
export function isDnsFailure(error: unknown): boolean {
  const text =
    String((error as { cause?: { code?: string } })?.cause?.code ?? "") + " " + String(error);
  return /ENOTFOUND|EAI_AGAIN|ENOENT/i.test(text);
}
