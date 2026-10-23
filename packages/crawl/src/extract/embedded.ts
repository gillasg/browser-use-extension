// Reading server-rendered pages without a DOM: embedded app state and JSON-LD.
//
// Copied from site-to-api (`src/infer/html.ts`) so browser-crawl can stand alone. Keep the two in
// step when the extractor learns a new framework.

export interface Embedded {
  next?: unknown;
  nuxt?: unknown;
  apollo?: unknown;
  redux?: unknown;
  jsonLd?: unknown[];
  json?: unknown[];
}

const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

function attr(attributes: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(
    attributes,
  );
  return match ? (match[2] ?? match[3] ?? match[4]) : undefined;
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text.trim());
  } catch {
    return undefined;
  }
}

/** Script JSON without the CDATA and comment wrappers pages put around it. */
function scriptJson(body: string): string {
  return body
    .trim()
    .replace(/^(?:\/\*\s*)?<!\[CDATA\[(?:\s*\*\/)?/, "")
    .replace(/(?:\/\*\s*)?\]\]>(?:\s*\*\/)?$/, "")
    .replace(/^<!--/, "")
    .replace(/-->$/, "")
    .trim();
}

/** The object literal starting at `start` (a `{`), respecting strings: `{...}` up to its match. */
function balancedObject(text: string, start: number): string | undefined {
  let depth = 0;
  let quote = "";
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return undefined;
}

const ASSIGNMENTS: [keyof Embedded, RegExp][] = [
  ["apollo", /window\.__APOLLO_STATE__\s*=\s*/],
  [
    "redux",
    /window\.(__PRELOADED_STATE__|__INITIAL_STATE__|__REDUX_STATE__|__STATE__|__DATA__)\s*=\s*/,
  ],
];

function assignment(body: string, pattern: RegExp): unknown {
  const match = pattern.exec(body);
  if (!match) return undefined;
  const start = body.indexOf("{", match.index + match[0].length - 1);
  const literal = start >= 0 ? balancedObject(body, start) : undefined;
  return literal ? tryJson(literal) : undefined;
}

function pushJson(
  list: unknown[] | undefined,
  body: string,
  objectsOnly: boolean,
): unknown[] | undefined {
  const value = tryJson(body);
  if (value === undefined || (objectsOnly && (!value || typeof value !== "object"))) return list;
  return [...(list ?? []), value];
}

function scriptData(embedded: Embedded, attributes: string, body: string): void {
  const id = attr(attributes, "id");
  const type = attr(attributes, "type")?.toLowerCase();
  if (id === "__NEXT_DATA__") embedded.next = tryJson(body);
  else if (id === "__NUXT_DATA__") embedded.nuxt = tryJson(body);
  else if (type === "application/ld+json")
    embedded.jsonLd = pushJson(embedded.jsonLd, scriptJson(body), false);
  else if (type === "application/json")
    embedded.json = pushJson(embedded.json, scriptJson(body), true);
  else
    for (const [key, pattern] of ASSIGNMENTS) {
      const value = assignment(body, pattern);
      if (value !== undefined) (embedded as Record<string, unknown>)[key] = value;
    }
}

export function extractEmbedded(html: string): Embedded {
  const embedded: Embedded = {};
  for (const match of html.matchAll(SCRIPT)) scriptData(embedded, match[1] ?? "", match[2] ?? "");
  return embedded;
}
