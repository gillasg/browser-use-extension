import { createHash } from "node:crypto";
import {
  clean,
  images,
  links,
  mainHtml,
  metadata,
  pageData,
  parse,
  product,
  tables,
  text,
  toMarkdown,
} from "./content/html.js";
import { fileKind, fileToMarkdown } from "./content/files.js";
import { extractCss } from "./extract/css.js";
import { extractJson, summarize, type ModelLike } from "./extract/model.js";
import { AutoFetcher } from "./fetch/auto.js";
import type { Fetched, Validators } from "./fetch/types.js";
import { fitMarkdown, pageScore } from "./relevance.js";
import type { Format, PageResult, ScrapeOptions } from "./types.js";

// One page in, every requested format out.

export const DEFAULT_FORMATS: Format[] = ["markdown", "metadata", "links"];

export interface ScrapeContext {
  fetcher: AutoFetcher;
  model?: ModelLike;
}

const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 32);

function decode(fetched: Fetched): string {
  if (fetched.html !== undefined) return fetched.html;
  const charset = /charset=([\w-]+)/i.exec(fetched.contentType)?.[1]?.toLowerCase() ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(fetched.body);
  } catch {
    return fetched.body.toString("utf8");
  }
}

function base(fetched: Fetched, depth: number): PageResult {
  return {
    url: fetched.url,
    finalUrl: fetched.finalUrl,
    status: fetched.status,
    depth,
    fetchedBy: fetched.fetchedBy,
    fetchedAt: new Date().toISOString(),
    contentType: fetched.contentType,
  };
}

interface HtmlParts {
  html: string;
  url: string;
  doc: ReturnType<typeof clean>["doc"];
  cleanedHtml: string;
  meta: Record<string, unknown>;
  main: string;
  markdown: string;
  data: Record<string, unknown>;
  query?: string;
}

/** What each format is made from; only the requested ones are computed. */
const HTML_FORMATS: Partial<Record<Format, (parts: HtmlParts) => unknown>> = {
  markdown: (p) => p.markdown,
  mainMarkdown: (p) => p.main,
  fitMarkdown: (p) => fitMarkdown(p.markdown, p.query),
  html: (p) => p.cleanedHtml,
  cleanedHtml: (p) => p.cleanedHtml,
  rawHtml: (p) => p.html,
  text: (p) => text(p.doc),
  links: (p) => links(p.doc, p.url),
  images: (p) => images(p.doc, p.url),
  metadata: (p) => p.meta,
  tables: (p) => tables(p.doc),
  pageData: (p) => p.data,
  product: (p) => product(p.data),
};

/** HTML pages: Markdown, links, metadata and the rest, computed only when asked for. */
function fromHtml(
  result: PageResult,
  html: string,
  fetched: Fetched,
  options: ScrapeOptions,
  formats: Set<Format>,
): void {
  const url = fetched.finalUrl;
  const { doc, cleanedHtml } = clean(html, url, options);
  const meta = metadata(parse(html), url);
  const main = toMarkdown(mainHtml(doc));
  const markdown =
    options.onlyMainContent === false ? toMarkdown(cleanedHtml) : main || toMarkdown(cleanedHtml);
  const parts: HtmlParts = {
    html,
    url,
    doc,
    cleanedHtml,
    meta,
    main,
    markdown,
    data: { ...pageData(html), ...(fetched.pageData ?? {}) },
    ...(options.query ? { query: options.query } : {}),
  };
  result.title = String(meta.title ?? "");
  const out = result as unknown as Record<string, unknown>;
  for (const format of formats) {
    const value = HTML_FORMATS[format]?.(parts);
    if (value !== undefined) out[format] = value;
  }
  result.contentHash = hash(markdown);
  if (options.query) result.score = pageScore(markdown, options.query);
}

async function fromFile(
  result: PageResult,
  fetched: Fetched,
  formats: Set<Format>,
): Promise<boolean> {
  const kind = fileKind(fetched.contentType, fetched.finalUrl);
  if (!kind) return false;
  const converted = await fileToMarkdown(kind, fetched.body);
  if (converted.title) result.title = converted.title;
  if (formats.has("markdown") || formats.has("mainMarkdown")) result.markdown = converted.markdown;
  if (formats.has("text")) result.text = converted.markdown;
  result.contentHash = hash(converted.markdown);
  return true;
}

function fromJson(result: PageResult, json: unknown, formats: Set<Format>): void {
  const markdown = "```json\n" + JSON.stringify(json, null, 2) + "\n```";
  result.json = json;
  if (formats.has("markdown")) result.markdown = markdown;
  if (formats.has("pageData")) result.pageData = json as Record<string, unknown>;
  result.contentHash = hash(JSON.stringify(json));
}

async function extras(
  result: PageResult,
  html: string | undefined,
  options: ScrapeOptions,
  formats: Set<Format>,
  context: ScrapeContext,
): Promise<void> {
  const extract = options.extract;
  if (extract?.css && html) result.json = extractCss(html, extract.css, result.finalUrl);
  else if (extract?.schema || extract?.prompt)
    result.json = await extractJson(result.markdown ?? html ?? "", extract, context.model);
  if (formats.has("summary") && result.markdown)
    result.summary = await summarize(result.markdown, context.model);
}

function fromOther(result: PageResult, fetched: Fetched, formats: Set<Format>): void {
  if (/json/i.test(fetched.contentType))
    return fromJson(result, JSON.parse(fetched.body.toString("utf8") || "null"), formats);
  result.text = fetched.body.toString("utf8").slice(0, 2_000_000);
  if (formats.has("markdown")) result.markdown = result.text;
  result.contentHash = hash(result.text);
}

/** Turns a fetched response into a page result with the requested formats. */
export async function buildResult(
  fetched: Fetched,
  options: ScrapeOptions,
  depth: number,
  context: ScrapeContext,
): Promise<PageResult> {
  const formats = new Set(options.formats ?? DEFAULT_FORMATS);
  const result = base(fetched, depth);
  for (const key of ["screenshot", "pdf", "mhtml"] as const)
    if (formats.has(key) && fetched[key]) result[key] = fetched[key];
  if (fetched.json !== undefined) {
    fromJson(result, fetched.json, formats);
    return result;
  }
  if (await fromFile(result, fetched, formats)) return result;
  const isHtml = /html|xml/i.test(fetched.contentType) || fetched.html !== undefined;
  const html = isHtml ? decode(fetched) : undefined;
  if (html !== undefined) fromHtml(result, html, fetched, options, formats);
  else fromOther(result, fetched, formats);
  await extras(result, html, options, formats, context);
  return result;
}

/** Fetches and converts one page. */
export async function scrape(
  url: string,
  options: ScrapeOptions = {},
  context?: Partial<ScrapeContext>,
  validators?: Validators,
): Promise<PageResult> {
  const ctx: ScrapeContext = {
    fetcher: context?.fetcher ?? new AutoFetcher(),
    ...(context?.model ? { model: context.model } : {}),
  };
  try {
    const fetched = await ctx.fetcher.fetch(url, options, validators);
    return await buildResult(fetched, options, 0, ctx);
  } finally {
    if (!context?.fetcher) await ctx.fetcher.close();
  }
}
