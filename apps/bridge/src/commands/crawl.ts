import { resolve } from "node:path";
import {
  crawl,
  findList,
  mapSite,
  scrape,
  search,
  writeOutput,
  type Format,
} from "@browserkit/tools/browser-crawl";
import { flag, has, list, type Args } from "../args.js";
import { out, printJson, printRows } from "../output.js";
import type { Command } from "../usage.js";

// Reading the web: one page, a site or section, its URL list, a Google search, or a list built
// from results. Plain HTTP first; the browser (with its logins) when a page needs one.

const ACTIONS = ["scrape", "map", "search", "find"] as const;
type Action = (typeof ACTIONS)[number] | "crawl";

const DEFAULT_FORMATS: Format[] = ["markdown", "metadata"];

function action(args: Args): { action: Action; target: string } {
  const [first, second] = args.positional;
  if (first && (ACTIONS as readonly string[]).includes(first))
    return { action: first as Action, target: second ?? "" };
  return { action: "crawl", target: first ?? "" };
}

function render(args: Args): "auto" | "static" | "browser" {
  const value = flag(args, "render");
  return value === "static" || value === "browser" ? value : "auto";
}

function formats(args: Args): Format[] {
  const chosen = list(args, "formats");
  return chosen.length ? (chosen as Format[]) : DEFAULT_FORMATS;
}

function crawlOptions(args: Args): Parameters<typeof crawl>[0] {
  const start = action(args).target;
  const wholeSite = has(args, "site") ? new URL(start).origin : start;
  const include = list(args, "include");
  const exclude = list(args, "exclude");
  const query = flag(args, "query");
  return {
    url: wholeSite,
    limit: Number(flag(args, "limit") ?? 25),
    formats: formats(args),
    render: render(args),
    ...(flag(args, "depth") ? { maxDepth: Number(flag(args, "depth")) } : {}),
    ...(include.length ? { include } : {}),
    ...(exclude.length ? { exclude } : {}),
    ...(query ? { query, strategy: "best" as const } : {}),
  };
}

async function runScrape(target: string, args: Args): Promise<number> {
  const query = flag(args, "query");
  printJson(
    await scrape(target, {
      formats: formats(args),
      render: render(args),
      ...(query ? { query } : {}),
    }),
  );
  return 0;
}

async function runMap(target: string, args: Args): Promise<number> {
  const query = flag(args, "query");
  const urls = await mapSite(target, {
    limit: Number(flag(args, "limit") ?? 500),
    ...(query ? { search: query } : {}),
  });
  if (has(args, "json")) printJson(urls);
  else printRows(urls.map((item) => [item.url, item.title]));
  return 0;
}

async function runSearch(target: string, args: Args): Promise<number> {
  const results = await search(target, { limit: Number(flag(args, "limit") ?? 10) });
  if (has(args, "json")) printJson(results);
  else printRows(results.map((item) => [item.url, item.title, item.snippet]));
  return 0;
}

async function runFind(target: string, args: Args): Promise<number> {
  const columns: Record<string, string> = {};
  for (const pair of list(args, "columns")) {
    const [name, ...what] = pair.split("=");
    if (name) columns[name] = what.join("=") || name;
  }
  const criteria = flag(args, "criteria");
  const rows = await findList(target, {
    columns: Object.keys(columns).length ? columns : { name: "name" },
    ...(criteria ? { criteria } : {}),
  });
  if (has(args, "json")) printJson(rows);
  else printRows(rows.map((row) => [row.url, ...Object.values(row.values).map(String)]));
  return 0;
}

async function runCrawl(args: Args): Promise<number> {
  const { action: kind, target } = action(args);
  if (!target)
    throw new Error(
      "Usage: browserkit crawl <url> | browserkit crawl <scrape|map|search|find> <target>",
    );
  if (kind === "scrape") return runScrape(target, args);
  if (kind === "map") return runMap(target, args);
  if (kind === "search") return runSearch(target, args);
  if (kind === "find") return runFind(target, args);
  const outDir = flag(args, "out");
  const pages = await crawl(crawlOptions(args));
  if (outDir) {
    await writeOutput(pages, resolve(outDir));
    out(`Wrote ${pages.length} pages to ${outDir}`);
    return 0;
  }
  if (has(args, "json")) printJson(pages);
  else printRows(pages.map((page) => [page.url, page.status, page.markdown?.length ?? 0]));
  return 0;
}

export const crawlCommand: Command = {
  name: "crawl",
  group: "Read the web",
  summary: "crawl a page's site or section as Markdown and data",
  help: `Usage: browserkit crawl <url> [--limit n] [--depth n] [--formats f,f] [--site]
       browserkit crawl scrape <url>
       browserkit crawl map <url>
       browserkit crawl search <query>
       browserkit crawl find <query> --columns name=what

  --limit <n>            pages to fetch (default 25; 500 for map)
  --depth <n>            link levels to follow
  --include <patterns>   only these URL patterns, comma separated ('/docs/**')
  --exclude <patterns>   never these
  --formats <list>       markdown (default), fitMarkdown, text, links, metadata, tables, pageData
  --render <mode>        auto (default), static, browser
  --query <text>         rank pages and keep the relevant parts
  --site                 start from the site's root instead of this page
  --out <dir>            write every page there
  --json                 the whole answer as JSON

Subcommands: scrape one page, map a site's URLs, search Google, or find rows that meet criteria
(find needs a model from the caller). Plain HTTP is tried first; pages that need JavaScript or a
sign-in go through your browser.`,
  run: runCrawl,
};

export const scrapeCommand: Command = {
  name: "scrape",
  group: "Read the web",
  summary: "read one page as Markdown, text or data",
  help: `Usage: browserkit scrape <url> [--formats f,f] [--render auto|static|browser] [--query text] [--json]`,
  run: (args) => {
    const target = args.positional[0];
    if (!target) throw new Error("Usage: browserkit scrape <url>");
    return runScrape(target, args);
  },
};

export const urlMapCommand: Command = {
  name: "map-urls",
  group: "Read the web",
  summary: "list a site's URLs (sitemaps and links)",
  help: `Usage: browserkit map-urls <url> [--limit n] [--query text] [--json]`,
  run: (args) => {
    const target = args.positional[0];
    if (!target) throw new Error("Usage: browserkit map-urls <url>");
    return runMap(target, args);
  },
};

export const searchCommand: Command = {
  name: "search",
  group: "Read the web",
  summary: "search Google through your browser",
  help: `Usage: browserkit search <query> [--limit n] [--json]`,
  run: (args) => {
    const target = args.positional.join(" ");
    if (!target) throw new Error("Usage: browserkit search <query>");
    return runSearch(target, args);
  },
};

export const findCommand: Command = {
  name: "find",
  group: "Read the web",
  summary: "build a list from the web that meets criteria (needs a model)",
  help: `Usage: browserkit find <query> --columns <name=what,...> [--criteria text] [--json]

  --columns name=what,price=what it costs   the fields to fill in for every row
  --criteria "under 500"                    what every row must be

Searches, reads the results, and keeps pages that meet the criteria. Needs a model from the
caller, which a standalone CLI does not have: call findList() in code for that.`,
  run: (args) => {
    const target = args.positional.join(" ");
    if (!target) throw new Error("Usage: browserkit find <query> --columns name=what");
    return runFind(target, args);
  },
};
