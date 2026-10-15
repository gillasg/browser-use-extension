import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  crawl,
  mapSite,
  scrape,
  search,
  type Format,
} from "@browser-use-extension/tools/browser-crawl";
import {
  importCaptures,
  listSites,
  loadModel,
  rebuild,
  siteApi,
  siteName,
} from "@browser-use-extension/tools/site-to-api";
import { dataDirectory } from "./paths.js";

// crawl and site_api for MCP clients: browser-crawl reads pages and sites, site-to-api turns
// sites mapped from captures into APIs. Both reach this browser through the bridge themselves.

type Json = Record<string, unknown>;
const MAX_TEXT = 60_000;
const FORMATS = ["markdown", "fitMarkdown", "text", "links", "metadata", "tables", "pageData"];
const HOW_TO_CALL =
  "Pass params flat: path and query parameters and top-level body fields by name, for example {query: 'shoes', page: 2}. Anything left out keeps the value recorded from the site.";

const strings = { type: "array", items: { type: "string" }, maxItems: 20 };

export const webTools = [
  {
    name: "crawl",
    description:
      "Read web pages as Markdown and data: scrape a URL, crawl a site or section (include ['/docs/**']), map a site's URLs, or search Google. Plain HTTP first, this browser (with its logins) when a page needs it. Prefer it over browser_code to read many pages; use browser_code to act on pages.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["scrape", "crawl", "map", "search"] },
        url: { type: "string" },
        query: {
          type: "string",
          description: "Search terms, or what to look for: ranks pages and keeps relevant parts.",
        },
        limit: { type: "integer", minimum: 1, maximum: 1000 },
        maxDepth: { type: "integer", minimum: 0, maximum: 20 },
        include: strings,
        exclude: strings,
        formats: { type: "array", items: { type: "string", enum: FORMATS } },
        render: { type: "string", enum: ["auto", "static", "browser"] },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "site_api",
    description: `Call the APIs of sites mapped from this browser's own traffic: one call replaces many page actions and returns JSON, with the user's logins. sites lists mapped sites; operations lists what a site can do; call runs one. To map a site: in browser_code open it, await tab.network.start({ types: 'all' }), do something that loads new data, then await tab.network.save('<site>.har'); then learn with files ['<site>.har']. ${HOW_TO_CALL}`,
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["sites", "operations", "call", "learn"] },
        site: { type: "string" },
        operation: { type: "string" },
        params: { type: "object" },
        files: { ...strings, description: "Captures saved by browser_code (session 'mcp')." },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
];

const text = (value: unknown): string => {
  const out = typeof value === "string" ? value : JSON.stringify(value, null, 1);
  return out.length > MAX_TEXT
    ? `${out.slice(0, MAX_TEXT)}\n[... ${out.length - MAX_TEXT} more characters clipped]`
    : out;
};

const requireString = (value: unknown, what: string): string => {
  if (typeof value !== "string" || !value) throw new Error(`Give the ${what}`);
  return value;
};

async function runCrawl(args: Json): Promise<unknown> {
  const formats =
    (args.formats as Format[] | undefined) ??
    (args.query ? ["fitMarkdown", "metadata"] : ["markdown", "metadata"]);
  const render = (args.render as "auto" | "static" | "browser" | undefined) ?? "auto";
  const query = typeof args.query === "string" ? args.query : undefined;
  if (args.action === "search")
    return search(requireString(query, "query"), { limit: Number(args.limit ?? 10) });
  const url = requireString(args.url, "url");
  if (args.action === "scrape")
    return scrape(url, { formats, render, ...(query ? { query } : {}) });
  if (args.action === "map")
    return mapSite(url, { limit: Number(args.limit ?? 500), ...(query ? { search: query } : {}) });
  return crawl({
    url,
    limit: Number(args.limit ?? 25),
    formats,
    render,
    ...(typeof args.maxDepth === "number" ? { maxDepth: args.maxDepth } : {}),
    ...(Array.isArray(args.include) ? { include: args.include as string[] } : {}),
    ...(Array.isArray(args.exclude) ? { exclude: args.exclude as string[] } : {}),
    ...(query ? { query, strategy: "best" as const } : {}),
  });
}

type Operation = NonNullable<Awaited<ReturnType<typeof loadModel>>>["operations"][number];
const describe = (op: Operation): Json => ({
  id: op.id,
  what: op.summary,
  method: op.method,
  path: op.path,
  role: op.role,
  params: op.params
    .filter((p) => !p.constant && !p.generated)
    .map((p) => `${p.name}${p.required ? "" : "?"}`),
});

async function learn(site: string, files: unknown): Promise<unknown> {
  if (!Array.isArray(files) || !files.length)
    throw new Error("learn needs captures: save one with tab.network.save('<site>.har') first");
  const workspace = join(dataDirectory(), "workspaces", "mcp");
  const paths = (files as string[]).map((file) => resolve(workspace, file));
  if (paths.some((path) => !path.startsWith(resolve(workspace))))
    throw new Error("Captures must be in the workspace of browser_code session 'mcp'");
  for (const path of paths) {
    const har = JSON.parse(await readFile(path, "utf8")) as { log?: { entries?: unknown[] } };
    if (!har.log?.entries?.length) throw new Error(`${path} has no requests`);
  }
  await importCaptures(site, paths);
  const result = await rebuild(site);
  return { site, howToCall: HOW_TO_CALL, operations: result.model.operations.map(describe) };
}

async function runSiteApi(args: Json): Promise<unknown> {
  if (args.action === "sites") return { sites: await listSites() };
  const site = siteName(requireString(args.site, "site, for example shop.example.com"));
  if (args.action === "learn") return learn(site, args.files);
  if (args.action === "operations") {
    const model = await loadModel(site);
    if (!model) throw new Error(`${site} is not mapped yet: capture its traffic and use learn`);
    return { site, howToCall: HOW_TO_CALL, operations: model.operations.map(describe) };
  }
  const api = await siteApi(site);
  return api.call(requireString(args.operation, "operation id"), (args.params ?? {}) as never);
}

/** Runs crawl or site_api; undefined when the tool is neither. */
export async function callWebTool(name: unknown, args: Json): Promise<unknown> {
  if (name !== "crawl" && name !== "site_api") return undefined;
  try {
    const value = name === "crawl" ? await runCrawl(args) : await runSiteApi(args);
    return { content: [{ type: "text", text: text(value) }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
}
