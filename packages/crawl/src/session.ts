// A session exported from the user's browser (only when they ask for it): cookies for the
// site's origins plus web storage, so calls can run from Node without a browser.
//
// Copied from site-to-api (`src/runtime/session.ts`) so browser-crawl can stand alone. The file
// format is site-to-api's `~/.site-to-api/sites/<site>/session.json`.

export interface SessionCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure?: boolean;
  httpOnly?: boolean;
  /** Seconds since the epoch; -1 or missing for session cookies. */
  expires?: number;
}

export interface SessionFile {
  site: string;
  savedAt: string;
  userAgent?: string;
  language?: string;
  cookies: SessionCookie[];
  /** By origin. */
  localStorage?: Record<string, Record<string, string>>;
  sessionStorage?: Record<string, Record<string, string>>;
}

function domainMatches(host: string, domain: string): boolean {
  const bare = domain.replace(/^\./, "");
  return host === bare || host.endsWith("." + bare);
}

export function cookieHeader(session: SessionFile, url: string): string {
  const target = new URL(url);
  const now = Date.now() / 1000;
  return session.cookies
    .filter(
      (cookie) =>
        domainMatches(target.hostname, cookie.domain) &&
        target.pathname.startsWith(cookie.path || "/") &&
        (!cookie.secure ||
          target.protocol === "https:" ||
          target.hostname === "localhost" ||
          target.hostname === "127.0.0.1") &&
        (cookie.expires === undefined || cookie.expires <= 0 || cookie.expires > now),
    )
    .sort((a, b) => (b.path || "/").length - (a.path || "/").length)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}
