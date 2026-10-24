// Why a browser.fetch failed, in words an agent can act on: a name that does not resolve, a TLS
// certificate the browser rejects, a refused connection, a reset, a timeout, a request the browser
// would not make (CORS or headers), or a block page answered by the network. Chrome reports most of
// these as an opaque "Failed to fetch", so the kind is read from a probe of the same host.

export type FetchKind = "dns" | "tls" | "refused" | "reset" | "timeout" | "cors" | "blocked-page";

/** What a probe of the host found, when one was run. */
export interface Probe {
  /** net::ERR_* reported by a navigation to the host, if it failed. */
  netError?: string;
  /** Where a navigation to the host ended, and what it showed, when it loaded. */
  finalUrl?: string;
  title?: string;
  text?: string;
}

export interface FetchDiagnosis {
  kind: FetchKind;
  /** A name that resolves to a block or sinkhole page: a network-level block, not a dead host. */
  networkBlock?: boolean;
  detail?: string;
  readable: string;
}

const NET_KINDS: readonly [RegExp, FetchKind][] = [
  [/ERR_(NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|DNS_)/, "dns"],
  [/ERR_(CERT_|SSL_|TLS_|BAD_SSL_)/, "tls"],
  [/ERR_CONNECTION_REFUSED/, "refused"],
  [
    /ERR_(CONNECTION_(RESET|CLOSED|ABORTED)|EMPTY_RESPONSE|NETWORK_CHANGED|CONTENT_LENGTH_MISMATCH)/,
    "reset",
  ],
  [/ERR_(TIMED_OUT|CONNECTION_TIMED_OUT)/, "timeout"],
  [/ERR_(BLOCKED_BY_CLIENT|BLOCKED_BY_RESPONSE|BLOCKED_BY_ADMINISTRATOR)/, "blocked-page"],
];

/** A net:: error code as a kind, exact enough to keep ERR_SSL_PROTOCOL_ERROR out of "reset". */
export function kindOfNetError(error: string | undefined): FetchKind | undefined {
  if (!error) return undefined;
  for (const [pattern, kind] of NET_KINDS) if (pattern.test(error)) return kind;
  return /ERR_(FAILED|SOCKET_NOT_CONNECTED|ADDRESS_UNREACHABLE)/.test(error) ? "reset" : undefined;
}

const BLOCK_TEXT =
  /(blocked by your (isp|internet)|access (to this|denied)|this (site|domain|page) (has been|was) blocked|web (filter|filtering)|parental controls|policy (blocked|denied)|blocked by (a |your )?(network|firewall|administrator)|sinkhole|threat (was )?detected|not allowed (on|by) (this|your) network|dns (filtering|block)|pornography|restricted content)/i;

const SINKHOLE_HOSTS =
  /(^|\.)(blocked|blockpage|sinkhole|block|deny|warning|filter|nanny|safe[-.]?search|isp[-.]?(block|warning))\./i;

/** A page that is not the site: the network refused it and answered with a warning instead. */
export function looksLikeBlockPage(probe: Probe, requestedHost: string): boolean {
  const text = `${probe.title ?? ""} ${probe.text ?? ""}`.slice(0, 4000);
  if (BLOCK_TEXT.test(text)) return true;
  const final = hostOf(probe.finalUrl);
  return Boolean(final && SINKHOLE_HOSTS.test(final + ".") && final !== requestedHost);
}

export function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

const PHRASE: Record<FetchKind, (host: string) => string> = {
  dns: (host) => `DNS lookup failed for ${host}: the name does not resolve`,
  tls: (host) => `TLS failed talking to ${host}: the certificate or handshake was rejected`,
  refused: (host) => `connection refused by ${host}: nothing is listening`,
  reset: (host) => `connection reset talking to ${host}`,
  timeout: (host) => `no answer from ${host} in time`,
  cors: (host) => `${host} answered, but the browser refused the request (CORS or headers)`,
  "blocked-page": (host) => `${host} answered with a block page, not the site`,
};

/** The readable message plus the machine-readable fields browser.fetch puts on the error. */
export function diagnosisOf(
  kind: FetchKind,
  host: string,
  probe?: Probe,
  detail?: string,
): FetchDiagnosis {
  const networkBlock =
    kind === "dns" || kind === "blocked-page"
      ? Boolean(probe && looksLikeBlockPage(probe, host))
      : false;
  let readable = PHRASE[kind](host);
  if (networkBlock && probe) readable += ` — a network-level block: ${blockEvidence(probe, host)}`;
  else if (kind === "dns" && probe?.finalUrl && hostOf(probe.finalUrl) !== host)
    readable += ` (it went to ${probe.finalUrl})`;
  const diagnosis: FetchDiagnosis = { kind, readable };
  if (networkBlock) diagnosis.networkBlock = true;
  if (detail) diagnosis.detail = detail.slice(0, 300);
  return diagnosis;
}

function blockEvidence(probe: Probe, host: string): string {
  const final = hostOf(probe.finalUrl);
  if (probe.finalUrl && final && final !== host) return `the name resolves to ${probe.finalUrl}`;
  const title = probe.title?.trim();
  if (title) return `the answer is a block page titled "${title.slice(0, 120)}"`;
  return "the answer is a block page, not the site";
}

/** One line, readable first, fields the caller parses in brackets. */
export function failureMessage(diagnosis: FetchDiagnosis, host: string): string {
  const fields = ["kind=" + diagnosis.kind, "host=" + host];
  if (diagnosis.networkBlock) fields.push("networkBlock=true");
  if (diagnosis.detail) fields.push("detail=" + diagnosis.detail.replace(/[\s\]]+/g, "_"));
  return diagnosis.readable + " [fetch " + fields.join(" ") + "]";
}
