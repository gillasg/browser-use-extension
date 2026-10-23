// The sign-in headers a site's own code adds to its API calls (Authorization, CSRF tokens), as
// last seen in recorded tabs, per origin. A site API call made from that site's page can then
// carry the header the site itself just sent, when the site keeps the value in memory where no
// recipe can read it. Memory only: never saved or learned, and not part of the documented
// browser-code API (only site-to-api's page transport asks for it).

const SESSION_HEADER =
  /^(authorization|x-csrf-token|x-xsrf-token|csrf-token|x-xsrftoken|x-csrftoken)$/i;
const FRESH_MS = 30 * 60_000;
const MAX_ORIGINS = 200;

const seen = new Map<string, { headers: Record<string, string>; at: number }>();

function originOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

/** Notes the sign-in headers of one request the site sent. */
export function rememberSessionHeaders(url: string, headers: Record<string, string>): void {
  const origin = originOf(url);
  if (!origin) return;
  const found = Object.entries(headers).filter(
    ([name, value]) => SESSION_HEADER.test(name) && value,
  );
  if (!found.length) return;
  const known = seen.get(origin)?.headers ?? {};
  seen.delete(origin);
  seen.set(origin, {
    headers: { ...known, ...Object.fromEntries(found.map(([n, v]) => [n.toLowerCase(), v])) },
    at: Date.now(),
  });
  if (seen.size > MAX_ORIGINS) seen.delete(seen.keys().next().value as string);
}

/** The sign-in headers the site sent to `url`'s origin in the last half hour, if any. */
export function sessionHeadersFor(url: string): Record<string, string> {
  const origin = originOf(url);
  const hit = origin ? seen.get(origin) : undefined;
  if (!hit || Date.now() - hit.at > FRESH_MS) return {};
  return { ...hit.headers };
}
