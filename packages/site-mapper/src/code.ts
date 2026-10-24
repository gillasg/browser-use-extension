import { sharedBridge } from "./runtime/bridge.js";

// How a site works: one read of its HTML, JS chunks, route manifests, source maps, robots and
// sitemap. Plain HTTP first; a refused or gated request is retried through the user's browser.

export interface SiteCodeOptions {
  /** One string or regex, or a list; matches are returned with file, line and context. */
  grep?: string | readonly string[];
  maxFiles?: number;
  maxBytes?: number;
  timeoutMs?: number;
}

export interface SiteCodeMatch {
  file: string;
  line: number;
  text: string;
}

export interface SiteCodeRoute {
  route: string;
  chunks: string[];
  source: string;
}

export interface SiteCodeResult {
  url: string;
  finalUrl: string;
  summary: string;
  routes: SiteCodeRoute[];
  files: { url: string; status: number; bytes: number; via: "http" | "chrome" }[];
  sourceMaps: { url: string; sources: string[] }[];
  robots: string[];
  sitemap: string[];
  matches: SiteCodeMatch[];
  notes: string[];
  truncated: boolean;
}

const DEFAULT_MAX_FILES = 80;
const DEFAULT_MAX_BYTES = 2_000_000;
const MAX_TOTAL_BYTES = 12_000_000;
const MAX_MATCHES = 120;
const DEFAULT_TIMEOUT = 15_000;

export async function code(input: string, options: SiteCodeOptions = {}): Promise<SiteCodeResult> {
  const url = pageUrl(input);
  const origin = new URL(url).origin;
  const maxFiles = Math.max(1, Math.min(200, options.maxFiles ?? DEFAULT_MAX_FILES));
  const maxBytes = Math.max(10_000, Math.min(8_000_000, options.maxBytes ?? DEFAULT_MAX_BYTES));
  const timeoutMs = Math.max(1_000, Math.min(60_000, options.timeoutMs ?? DEFAULT_TIMEOUT));
  const notes: string[] = [];
  let total = 0;
  const files: SiteCodeResult["files"] = [];
  const texts = new Map<string, string>();
  const page = await read(url, maxBytes, timeoutMs);
  texts.set(page.url, page.text);
  if (page.via === "chrome") notes.push("page read through the browser");
  const scripts = scriptsOf(page.text, page.url);
  const buildId =
    /\/_next\/static\/([^/"']+)\/_buildManifest\.js/.exec(page.text)?.[1] ??
    /"buildId"\s*:\s*"([^"]+)"/.exec(page.text)?.[1];
  const manifestUrls = manifestCandidates(page.url, buildId, scripts);
  const queue = [...new Set([...scripts, ...manifestUrls])].filter((item) =>
    sameOrigin(item, origin),
  );
  const seen = new Set<string>();
  const routeCandidates: { url: string; text: string; source: string }[] = [];
  for (const script of [...new Set(scripts)]) {
    if (!sameOrigin(script, origin) || seen.has(script) || files.length >= maxFiles) continue;
    seen.add(script);
    const file = await optional(script, maxBytes, timeoutMs);
    if (!file) continue;
    files.push(meta(file));
    texts.set(file.url, file.text);
    total += file.text.length;
    if (isManifestName(file.url)) routeCandidates.push({ ...file, source: file.url });
    if (total >= MAX_TOTAL_BYTES) {
      notes.push("stopped after the total size cap");
      break;
    }
  }
  for (const manifest of queue) {
    if (!sameOrigin(manifest, origin) || seen.has(manifest) || files.length >= maxFiles) continue;
    seen.add(manifest);
    const file = await optional(manifest, maxBytes, timeoutMs);
    if (!file) continue;
    files.push(meta(file));
    texts.set(file.url, file.text);
    total += file.text.length;
    routeCandidates.push({ ...file, source: "manifest" });
    if (total >= MAX_TOTAL_BYTES) break;
  }
  const routes = routeCandidates.flatMap((file) => routesFrom(file.url, file.text, file.source));
  const sourceMaps: SiteCodeResult["sourceMaps"] = [];
  for (const [fileUrl, text] of texts) {
    if (!/\.m?js(?:\?|$)/i.test(fileUrl)) continue;
    const mapUrl = sourceMapUrl(text, fileUrl) ?? `${fileUrl}.map`;
    if (!sameOrigin(mapUrl, origin) || seen.has(mapUrl)) continue;
    seen.add(mapUrl);
    const map = await optional(mapUrl, maxBytes, timeoutMs);
    if (!map) continue;
    files.push(meta(map));
    try {
      const parsed = JSON.parse(map.text) as { sources?: unknown };
      const sources = Array.isArray(parsed.sources)
        ? parsed.sources.filter((item): item is string => typeof item === "string")
        : [];
      if (sources.length) sourceMaps.push({ url: map.url, sources: sources.slice(0, 500) });
      for (const source of sources.slice(0, 500))
        for (const route of routeStrings(source))
          routes.push({ route, chunks: [map.url], source: "source-map" });
    } catch {
      notes.push(`source map was not JSON: ${map.url}`);
    }
  }
  const robotsUrl = new URL("/robots.txt", page.url).href;
  const robotsFile = await optional(robotsUrl, maxBytes, timeoutMs).catch(() => undefined);
  const robots = robotsFile
    ? robotsFile.text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    : [];
  const sitemaps = robots
    .map((line) => /^sitemap:\s*(\S+)/i.exec(line)?.[1])
    .filter((value): value is string => Boolean(value))
    .map((value) => {
      try {
        return new URL(value, page.url).href;
      } catch {
        return undefined;
      }
    })
    .filter((value): value is string => Boolean(value));
  const sitemap: string[] = [];
  for (const sitemapUrl of [...new Set(sitemaps)].slice(0, 4)) {
    const file = await optional(sitemapUrl, maxBytes, timeoutMs).catch(() => undefined);
    if (!file) continue;
    sitemap.push(...urlsFromSitemap(file.text));
    if (sitemap.length >= 500) break;
  }
  const matches = options.grep ? grepFiles(texts, options.grep) : [];
  const finalRoutes = uniqueRoutes(routes);
  return {
    url,
    finalUrl: page.url,
    summary: `${finalRoutes.length} routes, ${files.length} files, ${sourceMaps.length} source maps, ${matches.length} matches`,
    routes: finalRoutes,
    files,
    sourceMaps,
    robots: robots.slice(0, 100),
    sitemap: [...new Set(sitemap)].slice(0, 500),
    matches: matches.slice(0, MAX_MATCHES),
    notes,
    truncated: files.some((file) => file.bytes >= maxBytes) || matches.length > MAX_MATCHES,
  };
}

async function read(
  url: string,
  maxBytes: number,
  timeoutMs: number,
): Promise<{ url: string; status: number; text: string; via: "http" | "chrome" }> {
  let plain: string | undefined;
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "text/html,application/javascript,application/json,*/*" },
    });
    plain = (await response.text()).slice(0, maxBytes);
    if (response.ok || response.status === 404) {
      return { url: response.url || url, status: response.status, text: plain, via: "http" };
    }
  } catch {
    // fall through to the browser
  }
  try {
    const bridge = await sharedBridge();
    const value = (await bridge.run(
      `browser.fetch(${JSON.stringify(url)}, { as: "text", timeoutMs: ${timeoutMs} })`,
      { session: "site-code", timeoutMs: timeoutMs + 5_000 },
    )) as { status?: number; url?: string; text?: string };
    return {
      url: value.url || url,
      status: Number(value.status ?? 0),
      text: String(value.text ?? "").slice(0, maxBytes),
      via: "chrome",
    };
  } catch (error) {
    if (!plain) throw error;
    return { url, status: 0, text: plain, via: "http" };
  }
}

async function optional(url: string, maxBytes: number, timeoutMs: number) {
  try {
    if (!/^https?:/i.test(url)) return undefined;
    return await read(url, maxBytes, timeoutMs);
  } catch {
    return undefined;
  }
}

function meta(file: { url: string; status: number; text: string; via: "http" | "chrome" }) {
  return { url: file.url, status: file.status, bytes: file.text.length, via: file.via };
}

function pageUrl(input: string): string {
  const value = /^https?:\/\//i.test(input) ? input : `https://${input}`;
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("code needs an http(s) URL");
  return url.href;
}

function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

function scriptsOf(html: string, page: string): string[] {
  const found = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)].map(
    (match) => match[1],
  );
  return found
    .map((src) => {
      try {
        return new URL(src ?? "", page).href;
      } catch {
        return undefined;
      }
    })
    .filter((value): value is string => Boolean(value));
}

function manifestCandidates(
  page: string,
  buildId: string | undefined,
  scripts: string[],
): string[] {
  const origin = new URL(page).origin;
  const list = [
    "/build-manifest.json",
    "/asset-manifest.json",
    "/manifest.json",
    "/app-build-manifest.json",
    "/remix-manifest.json",
    "/.vite/manifest.json",
    ...(buildId
      ? [
          `/_next/static/${buildId}/_buildManifest.js`,
          `/_next/static/${buildId}/_ssgManifest.js`,
          `/_next/static/${buildId}/app-build-manifest.json`,
        ]
      : []),
  ].map((path) => new URL(path, origin).href);
  return [...list, ...scripts.filter(isManifestName)];
}

function isManifestName(url: string): boolean {
  return /(?:build|asset|routes|remix|vite)[^/]*manifest|manifest\.json/i.test(url);
}

function routesFrom(url: string, text: string, source: string): SiteCodeRoute[] {
  const routes: SiteCodeRoute[] = [];
  const pairs = [...text.matchAll(/["'](\/[^"']+)["']\s*:\s*\[([^\]]*)\]/g)];
  for (const pair of pairs) {
    const route = pair[1];
    if (!route || route.startsWith("//")) continue;
    const chunks = [...(pair[2] ?? "").matchAll(/["']([^"']+)["']/g)]
      .map((match) => {
        try {
          return new URL(match[1] ?? "", url).href;
        } catch {
          return undefined;
        }
      })
      .filter((value): value is string => Boolean(value));
    routes.push({ route, chunks, source });
  }
  if (routes.length) return routes;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    for (const [route, value] of Object.entries(parsed)) {
      if (!route.startsWith("/")) continue;
      const chunks =
        typeof value === "string"
          ? [value]
          : Array.isArray(value)
            ? value.filter((item): item is string => typeof item === "string")
            : value &&
                typeof value === "object" &&
                typeof (value as { file?: unknown }).file === "string"
              ? [(value as { file: string }).file]
              : [];
      routes.push({ route, chunks: chunks.map((chunk) => new URL(chunk, url).href), source });
    }
  } catch {
    // a JS manifest; the pair scan above is the useful part
  }
  return routes;
}

function sourceMapUrl(text: string, fileUrl: string): string | undefined {
  const found = /\/\/[#@]\s*sourceMappingURL=(\S+)/.exec(text)?.[1];
  if (!found) return undefined;
  try {
    return new URL(found, fileUrl).href;
  } catch {
    return undefined;
  }
}

function routeStrings(value: string): string[] {
  return [...value.matchAll(/\/(?:app|pages|routes|src)\/[^"'\s)]+/g)].map((match) => match[0]);
}

function urlsFromSitemap(text: string): string[] {
  return [...text.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)]
    .map((match) => match[1])
    .filter((value): value is string => Boolean(value));
}

function grepFiles(
  texts: Map<string, string>,
  patterns: string | readonly string[],
): SiteCodeMatch[] {
  const values = typeof patterns === "string" ? [patterns] : [...patterns];
  const matchers = values.map((value) => {
    try {
      return new RegExp(value, "i");
    } catch {
      return value;
    }
  });
  const matches: SiteCodeMatch[] = [];
  for (const [file, text] of texts) {
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] ?? "";
      if (
        !matchers.some((matcher) =>
          typeof matcher === "string" ? line.includes(matcher) : matcher.test(line),
        )
      )
        continue;
      matches.push({ file, line: index + 1, text: line.trim().slice(0, 120) });
      if (matches.length >= MAX_MATCHES) return matches;
    }
  }
  return matches;
}

function uniqueRoutes(routes: SiteCodeRoute[]): SiteCodeRoute[] {
  const seen = new Set<string>();
  return routes.filter((route) => {
    if (seen.has(route.route)) return false;
    seen.add(route.route);
    return true;
  });
}
