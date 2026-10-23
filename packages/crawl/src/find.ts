import { extractJson, type ModelLike } from "./extract/model.js";
import { searchAndScrape } from "./search.js";

// Find-and-fill: build a list from the web. Search, read each result, keep the ones that match the
// criteria, and fill in the columns for each, with the page each value came from:
//   await findList("seed-stage climate startups in India", {
//     criteria: "a company (not an article or list) that is seed stage",
//     columns: { name: "company name", founded: "year founded", funding: "latest round" },
//   })

export interface FindOptions {
  /** What every row must be, checked against each page. */
  criteria?: string;
  /** Column name → what to fill in. */
  columns: Record<string, string>;
  /** Extra searches to widen the list (the query itself is always searched). */
  queries?: string[];
  /** Search results to read per query (default 10). */
  perQuery?: number;
  model?: ModelLike;
}

export interface FoundRow {
  url: string;
  values: Record<string, unknown>;
}

const ROW_SCHEMA = (columns: Record<string, string>) => ({
  type: "object",
  properties: {
    matches: {
      type: "boolean",
      description: "Whether the page is about something that meets the criteria.",
    },
    rows: {
      type: "array",
      description: "One row per matching item on the page (a list page can have several).",
      items: {
        type: "object",
        properties: Object.fromEntries(
          Object.entries(columns).map(([name, what]) => [name, { description: what }]),
        ),
      },
    },
  },
  required: ["matches", "rows"],
});

function rowKey(values: Record<string, unknown>): string {
  const first = Object.values(values).find((value) => typeof value === "string" && value);
  return String(first ?? JSON.stringify(values))
    .toLowerCase()
    .trim();
}

type Found = { matches?: boolean; rows?: Record<string, unknown>[] } | undefined;

/** Reads one page: does it match, and the rows it holds. */
async function readPage(markdown: string, query: string, options: FindOptions): Promise<Found> {
  const criteria = options.criteria ? ` Every row must be: ${options.criteria}.` : "";
  return (await extractJson(
    markdown,
    {
      schema: ROW_SCHEMA(options.columns),
      prompt: `Building a list: ${query}.${criteria} Fill each column only from the page; null when the page does not say.`,
    },
    options.model,
  ).catch(() => undefined)) as Found;
}

function readResult(
  result: { page?: { fitMarkdown?: string; markdown?: string } },
  query: string,
  options: FindOptions,
): Promise<Found> {
  const markdown = result.page?.fitMarkdown ?? result.page?.markdown;
  return markdown ? readPage(markdown, query, options) : Promise.resolve(undefined);
}

function addRows(rows: Map<string, FoundRow>, url: string, found: Found): void {
  if (!found?.matches) return;
  for (const values of found.rows ?? []) {
    const key = rowKey(values);
    if (!rows.has(key)) rows.set(key, { url, values });
  }
}

/** Searches, checks each result against the criteria, and fills in the columns. */
export async function findList(query: string, options: FindOptions): Promise<FoundRow[]> {
  const rows = new Map<string, FoundRow>();
  for (const search of [query, ...(options.queries ?? [])]) {
    const results = await searchAndScrape(search, {
      limit: options.perQuery ?? 10,
      formats: ["markdown"],
    });
    for (const result of results)
      addRows(rows, result.url, await readResult(result, query, options));
  }
  return [...rows.values()];
}
