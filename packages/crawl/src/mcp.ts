import { createInterface } from "node:readline";
import { crawl } from "./crawler.js";
import { AutoFetcher } from "./fetch/auto.js";
import { mapSite } from "./map.js";
import { scrape } from "./scrape.js";
import { searchAndScrape } from "./search.js";
import { findList } from "./find.js";
import type { CrawlOptions, PageResult } from "./types.js";

// A stdio MCP server: scrape a page, map a site, crawl it, or search and read the results.

type Json = Record<string, unknown>;
const LIMIT = 80_000;

const common = {
  formats: {
    type: "array",
    items: { type: "string" },
    description:
      "markdown (default), mainMarkdown, fitMarkdown, html, text, links, metadata, tables, pageData, product, json, screenshot…",
  },
  render: {
    enum: ["auto", "static", "browser"],
    description: "auto: plain HTTP first, the user's browser when needed",
  },
  query: {
    type: "string",
    description: "What you are looking for: ranks pages and trims Markdown",
  },
};

const TOOLS = [
  {
    name: "scrape",
    description:
      "Read one web page as Markdown (or other formats), through the user's own browser when it needs a login or JavaScript.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" }, ...common, onlyMainContent: { type: "boolean" } },
      required: ["url"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "map",
    description:
      "List a site's URLs quickly (sitemaps and links), optionally ranked by a search phrase.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        search: { type: "string" },
        limit: { type: "integer" },
      },
      required: ["url"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "crawl",
    description:
      "Crawl a site (including pages behind the user's logins) and return each page's content. Keep limit small.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        limit: { type: "integer", default: 10 },
        maxDepth: { type: "integer" },
        include: { type: "array", items: { type: "string" } },
        exclude: { type: "array", items: { type: "string" } },
        ...common,
      },
      required: ["url"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "search",
    description: "Search Google in the user's browser and read the top results.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "integer", default: 5 } },
      required: ["query"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "find_list",
    description:
      "Build a list from the web: search Google in the user's browser, read each result, keep those that meet the criteria and fill in the columns, with the page each row came from. Needs a connected model.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        criteria: { type: "string", description: "What every row must be." },
        columns: {
          type: "object",
          description: "Column name → what to fill in, e.g. {founded: 'year founded'}.",
          additionalProperties: { type: "string" },
        },
        queries: { type: "array", items: { type: "string" }, description: "More searches." },
      },
      required: ["query", "columns"],
    },
    annotations: { readOnlyHint: true },
  },
];

function compact(page: PageResult): Json {
  const { links, ...rest } = page;
  return { ...rest, ...(links ? { links: links.slice(0, 50) } : {}) };
}

function result(value: unknown, isError = false): Json {
  let text = typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "null");
  if (text.length > LIMIT)
    text = text.slice(0, LIMIT) + `\n[${text.length - LIMIT} more characters clipped]`;
  return { content: [{ type: "text", text }], isError };
}

async function call(name: unknown, args: Json, fetcher: AutoFetcher): Promise<unknown> {
  if (name === "scrape")
    return compact(await scrape(String(args.url), args as CrawlOptions, { fetcher }));
  if (name === "map") return mapSite(String(args.url), args);
  if (name === "crawl")
    return (await crawl({ limit: 10, ...(args as CrawlOptions) }, { fetcher })).map(compact);
  if (name === "search")
    return searchAndScrape(String(args.query), {
      limit: Number(args.limit ?? 5),
      fetcher,
      formats: ["markdown"],
    });
  if (name === "find_list")
    return findList(String(args.query), {
      columns: args.columns as Record<string, string>,
      ...(typeof args.criteria === "string" ? { criteria: args.criteria } : {}),
      ...(Array.isArray(args.queries) ? { queries: args.queries as string[] } : {}),
    });
  throw new Error(`Unknown tool ${String(name)}`);
}

export async function runMcpServer(): Promise<void> {
  const fetcher = new AutoFetcher();
  const handle = async (message: Json): Promise<unknown> => {
    const params = (message.params ?? {}) as Json;
    if (message.method === "initialize")
      return {
        protocolVersion:
          typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "browser-crawl", version: "0.1.0" },
      };
    if (message.method === "ping") return {};
    if (message.method === "tools/list") return { tools: TOOLS };
    if (message.method !== "tools/call")
      throw new Error(`Unsupported method: ${String(message.method)}`);
    try {
      return result(await call(params.name, (params.arguments ?? {}) as Json, fetcher));
    } catch (error) {
      return result(error instanceof Error ? error.message : String(error), true);
    }
  };
  for await (const line of createInterface({ input: process.stdin })) {
    if (!line.trim()) continue;
    let message: Json;
    try {
      message = JSON.parse(line) as Json;
    } catch {
      continue;
    }
    if (message.id === undefined) continue;
    void handle(message).then(
      (value) =>
        process.stdout.write(
          JSON.stringify({ jsonrpc: "2.0", id: message.id, result: value }) + "\n",
        ),
      (error: unknown) =>
        process.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: -32603,
              message: error instanceof Error ? error.message : String(error),
            },
          }) + "\n",
        ),
    );
  }
  await fetcher.close();
}
