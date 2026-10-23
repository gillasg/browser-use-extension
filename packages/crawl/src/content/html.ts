import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { extractEmbedded } from "../extract/embedded.js";

// Turning a page's HTML into the formats people ask for: Markdown (whole page or main content),
// cleaned HTML, text, links, images, metadata, tables, embedded data and product records.

type Doc = ReturnType<typeof parseHTML>["document"];
type El = ReturnType<Doc["querySelector"]> & object;

const NOISE = "script, style, noscript, template, iframe, svg, canvas, link, meta, object, embed";
const BOILERPLATE =
  "nav, header, footer, aside, form, [role=navigation], [role=banner], [role=contentinfo], [aria-hidden=true], .cookie, .consent, .newsletter, .advert, .ads, .share, .social";

export function parse(html: string): Doc {
  return parseHTML(html.includes("<html") ? html : `<html><body>${html}</body></html>`).document;
}

let turndown: TurndownService | undefined;

function markdownService(): TurndownService {
  if (turndown) return turndown;
  turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "*",
  });
  turndown.use(gfm);
  turndown.remove(["script", "style", "noscript", "iframe"] as never);
  return turndown;
}

/** Makes links and images absolute, so Markdown and link lists work out of context. */
function absolutize(doc: Doc, base: string): void {
  for (const el of doc.querySelectorAll("a[href]") as unknown as El[]) {
    try {
      el.setAttribute("href", new URL(el.getAttribute("href") ?? "", base).href);
    } catch {
      continue;
    }
  }
  for (const el of doc.querySelectorAll("img[src]") as unknown as El[]) {
    try {
      el.setAttribute("src", new URL(el.getAttribute("src") ?? "", base).href);
    } catch {
      continue;
    }
  }
}

export function toMarkdown(html: string): string {
  return markdownService()
    .turndown(html)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface Cleaned {
  doc: Doc;
  cleanedHtml: string;
}

/** The page without scripts, styles and (optionally) chosen tags; only chosen tags when asked. */
export function clean(
  html: string,
  base: string,
  options: { includeTags?: string[]; excludeTags?: string[] } = {},
): Cleaned {
  const doc = parse(html);
  absolutize(doc, base);
  for (const el of doc.querySelectorAll(NOISE) as unknown as El[]) el.remove();
  for (const selector of options.excludeTags ?? [])
    for (const el of doc.querySelectorAll(selector) as unknown as El[]) el.remove();
  if (options.includeTags?.length) {
    const kept = options.includeTags.flatMap((selector) => [
      ...(doc.querySelectorAll(selector) as unknown as El[]),
    ]);
    const body = doc.querySelector("body");
    if (body) body.innerHTML = kept.map((el) => el.outerHTML).join("\n");
  }
  return { doc, cleanedHtml: (doc.querySelector("body")?.innerHTML ?? doc.toString()).trim() };
}

function readability(doc: Doc): string | undefined {
  try {
    const article = new Readability(doc.cloneNode(true) as never, { charThreshold: 200 }).parse();
    if (!article?.content || (article.textContent ?? "").trim().length <= 200) return undefined;
    // Readability lifts the page's heading into its title; keep it as the first heading.
    const heading = doc.querySelector("h1")?.textContent?.trim();
    if (!heading || article.content.includes(heading)) return article.content;
    return `<h1>${escapeHtml(heading)}</h1>${article.content}`;
  } catch {
    return undefined;
  }
}

/** Main content: Readability first, then the page without its navigation and footer. */
export function mainHtml(doc: Doc): string {
  const article = readability(doc);
  if (article) return article;
  const copy = doc.cloneNode(true) as Doc;
  for (const el of copy.querySelectorAll(BOILERPLATE) as unknown as El[]) el.remove();
  const main = copy.querySelector("main, article, [role=main]") ?? copy.querySelector("body");
  return main?.innerHTML ?? "";
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function links(doc: Doc, base: string): { url: string; text: string; internal: boolean }[] {
  const origin = new URL(base).host;
  const seen = new Set<string>();
  const out: { url: string; text: string; internal: boolean }[] = [];
  for (const el of doc.querySelectorAll("a[href]") as unknown as El[]) {
    let url: URL;
    try {
      url = new URL(el.getAttribute("href") ?? "", base);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(url.protocol) || el.getAttribute("rel")?.includes("nofollow-crawl"))
      continue;
    url.hash = "";
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    out.push({
      url: url.href,
      text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 200),
      internal: url.host === origin,
    });
  }
  return out;
}

export function images(doc: Doc, base: string): { url: string; alt: string }[] {
  const out: { url: string; alt: string }[] = [];
  for (const el of doc.querySelectorAll("img") as unknown as El[]) {
    const src =
      el.getAttribute("src") ||
      el.getAttribute("data-src") ||
      el.getAttribute("srcset")?.split(/\s/)[0];
    if (!src || src.startsWith("data:")) continue;
    try {
      out.push({ url: new URL(src, base).href, alt: el.getAttribute("alt") ?? "" });
    } catch {
      continue;
    }
  }
  return out;
}

function metaTags(doc: Doc): Record<string, string> {
  const meta: Record<string, string> = {};
  for (const el of doc.querySelectorAll("meta[name], meta[property]") as unknown as El[]) {
    const key = el.getAttribute("property") ?? el.getAttribute("name") ?? "";
    const value = el.getAttribute("content");
    if (key && value) meta[key] = value;
  }
  return meta;
}

function absolute(href: string | null | undefined, base: string): string | undefined {
  if (!href) return undefined;
  try {
    return new URL(href, base).href;
  } catch {
    return undefined;
  }
}

export function metadata(doc: Doc, base: string): Record<string, unknown> {
  const meta = metaTags(doc);
  return {
    title: doc.querySelector("title")?.textContent?.trim() ?? "",
    description: meta.description ?? meta["og:description"],
    language: doc.querySelector("html")?.getAttribute("lang") ?? undefined,
    canonical: absolute(doc.querySelector('link[rel="canonical"]')?.getAttribute("href"), base),
    published: meta["article:published_time"] ?? meta["date"],
    modified: meta["article:modified_time"] ?? meta["last-modified"],
    image: meta["og:image"],
    meta,
  };
}

/** Tables as rows keyed by header (the first row when there is no thead). */
export function tables(doc: Doc): Record<string, string>[][] {
  const out: Record<string, string>[][] = [];
  for (const table of doc.querySelectorAll("table") as unknown as El[]) {
    const rows = [...(table.querySelectorAll("tr") as unknown as El[])].map((row) =>
      [...(row.querySelectorAll("th, td") as unknown as El[])].map((cell) =>
        (cell.textContent ?? "").replace(/\s+/g, " ").trim(),
      ),
    );
    if (rows.length < 2) continue;
    const header = (rows[0] ?? []).map((cell, i) => cell || `column${i + 1}`);
    out.push(
      rows.slice(1).map((row) => Object.fromEntries(header.map((name, i) => [name, row[i] ?? ""]))),
    );
  }
  return out;
}

export function text(doc: Doc): string {
  return (doc.querySelector("body")?.textContent ?? "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

/** Embedded state and JSON-LD the server sent with the page. */
export function pageData(html: string): Record<string, unknown> {
  return extractEmbedded(html) as Record<string, unknown>;
}

function jsonLdNodes(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data.flatMap(jsonLdNodes);
  if (!data || typeof data !== "object") return [];
  const record = data as Record<string, unknown>;
  return [record, ...jsonLdNodes(record["@graph"])];
}

const num = (value: unknown): number | undefined =>
  value === undefined || value === null || value === "" ? undefined : Number(value);

function offerFields(offer: Record<string, unknown> | undefined): Record<string, unknown> {
  const availability =
    typeof offer?.availability === "string"
      ? offer.availability.replace(/^https?:\/\/schema\.org\//, "")
      : undefined;
  return {
    price: num(offer?.price ?? offer?.lowPrice),
    currency: offer?.priceCurrency,
    availability,
  };
}

/** A product record from JSON-LD (Product, with its offer and rating), normalised. */
export function product(embedded: Record<string, unknown>): Record<string, unknown> | undefined {
  const found = jsonLdNodes(embedded.jsonLd).find((node) =>
    [node["@type"]].flat().some((type) => /^Product$/i.test(String(type))),
  );
  if (!found) return undefined;
  const rating = (found.aggregateRating ?? {}) as Record<string, unknown>;
  const brand = found.brand as Record<string, unknown> | string | undefined;
  return {
    name: found.name,
    description: found.description,
    sku: found.sku ?? found.mpn,
    brand: typeof brand === "object" ? brand?.name : brand,
    image: [found.image].flat()[0],
    ...offerFields([found.offers].flat()[0] as Record<string, unknown> | undefined),
    rating: num(rating.ratingValue),
    reviews: num(rating.reviewCount),
  };
}
