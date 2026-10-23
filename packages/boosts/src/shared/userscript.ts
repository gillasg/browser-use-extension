import type { Boost, RunAt, ScriptMeta, SiteRule, StyleSection, UserCssVar } from "./types.js";

// Userscript (==UserScript==) and userstyle (==UserStyle==) headers, and turning either into a boost.

const LIST_KEYS = new Set([
  "match",
  "include",
  "exclude",
  "exclude-match",
  "grant",
  "require",
  "connect",
  "tag",
  "antifeature",
]);

/** The raw key/value lines of a header block. */
function headerLines(source: string, block: "UserScript" | "UserStyle"): Record<string, string[]> {
  const start = source.indexOf(`==${block}==`);
  const end = source.indexOf(`==/${block}==`);
  if (start < 0 || end < start) throw new Error(`No ==${block}== header found`);
  const raw: Record<string, string[]> = {};
  const lines = source.slice(start, end).split(/\r?\n/).slice(1);
  let last: string | undefined;
  for (const line of lines) {
    const parsed = /^\s*(?:\/\/)?\s*@([\w:.-]+)(?:\s+(.*?))?\s*$/.exec(line);
    if (parsed?.[1]) {
      last = parsed[1];
      (raw[last] ??= []).push(parsed[2] ?? "");
    } else if (last && block === "UserStyle" && line.trim() && !line.includes("==")) {
      // Multi-line @var/@advanced values (dropdown options) continue on the following lines.
      const values = raw[last] as string[];
      values[values.length - 1] += "\n" + line;
    }
  }
  return raw;
}

const first = (raw: Record<string, string[]>, key: string): string | undefined =>
  raw[key]?.[0]?.trim() || undefined;

/** Localised keys (@name:fr) fall back to the plain one. */
function localised(raw: Record<string, string[]>, key: string): string | undefined {
  const language = (globalThis.navigator?.language ?? "en").toLowerCase();
  return (
    first(raw, `${key}:${language}`) ??
    first(raw, `${key}:${language.split("-")[0]}`) ??
    first(raw, key)
  );
}

function runAtOf(value: string | undefined): ScriptMeta["runAt"] {
  const allowed = [
    "document-start",
    "document-body",
    "document-end",
    "document-idle",
    "context-menu",
  ];
  return value && allowed.includes(value) ? (value as RunAt) : undefined;
}

function resources(raw: Record<string, string[]>): ScriptMeta["resource"] {
  return (raw.resource ?? [])
    .map((line) => /^(\S+)\s+(\S+)$/.exec(line.trim()))
    .filter((parsed): parsed is RegExpExecArray => Boolean(parsed))
    .map((parsed) => ({ name: parsed[1] as string, url: parsed[2] as string }));
}

export function parseUserScript(source: string): ScriptMeta {
  const raw = headerLines(source, "UserScript");
  const list = (key: string): string[] =>
    (raw[key] ?? []).map((value) => value.trim()).filter(Boolean);
  const injectInto = first(raw, "inject-into") ?? sandboxToInject(first(raw, "sandbox"));
  return {
    name: localised(raw, "name") ?? "Untitled script",
    namespace: first(raw, "namespace"),
    version: first(raw, "version"),
    description: localised(raw, "description"),
    author: first(raw, "author"),
    homepage: first(raw, "homepageURL") ?? first(raw, "homepage") ?? first(raw, "website"),
    icon: first(raw, "icon") ?? first(raw, "iconURL") ?? first(raw, "defaulticon"),
    updateURL: first(raw, "updateURL"),
    downloadURL: first(raw, "downloadURL") ?? first(raw, "installURL"),
    supportURL: first(raw, "supportURL"),
    license: first(raw, "license"),
    match: list("match"),
    include: list("include"),
    exclude: list("exclude"),
    excludeMatch: list("exclude-match"),
    grant: list("grant"),
    require: list("require"),
    resource: resources(raw),
    connect: list("connect"),
    runAt: runAtOf(first(raw, "run-at")),
    noframes: "noframes" in raw,
    injectInto: injectInto === "page" || injectInto === "content" ? injectInto : "auto",
    tags: list("tag").flatMap((tag) => tag.split(/[\s,]+/)),
    antifeatures: list("antifeature"),
    unwrap: "unwrap" in raw,
    topLevelAwait: "top-level-await" in raw,
    raw,
  };
}

function sandboxToInject(sandbox: string | undefined): string | undefined {
  if (sandbox === "raw" || sandbox === "MAIN") return "page";
  if (sandbox === "JavaScript" || sandbox === "DOM") return "content";
  return undefined;
}

/** Whether a list key may repeat (used by the editor's hints). */
export const isListKey = (key: string): boolean => LIST_KEYS.has(key);

// ---- Userstyles -------------------------------------------------------------------------

export function parseUserStyle(source: string): ScriptMeta {
  const raw = headerLines(source, "UserStyle");
  const vars = [...(raw.var ?? []), ...(raw.advanced ?? [])]
    .map(parseVar)
    .filter((v): v is UserCssVar => Boolean(v));
  return {
    name: localised(raw, "name") ?? "Untitled style",
    namespace: first(raw, "namespace"),
    version: first(raw, "version"),
    description: localised(raw, "description"),
    author: first(raw, "author"),
    homepage: first(raw, "homepageURL"),
    updateURL: first(raw, "updateURL"),
    supportURL: first(raw, "supportURL"),
    license: first(raw, "license"),
    preprocessor: first(raw, "preprocessor") ?? "default",
    vars,
    match: [],
    include: [],
    exclude: [],
    excludeMatch: [],
    grant: [],
    require: [],
    resource: [],
    connect: [],
    tags: [],
    antifeatures: [],
    raw,
  };
}

const VAR_TYPES = ["text", "color", "checkbox", "select", "dropdown", "number", "range", "image"];

function unquote(text: string): string {
  const trimmed = text.trim();
  return /^(["']).*\1$/s.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}

function parseVar(line: string): UserCssVar | undefined {
  const parsed = /^(\w+)\s+([\w-]+)\s+("[^"]*"|'[^']*'|\S+)\s+([\s\S]*)$/.exec(line.trim());
  if (!parsed) return undefined;
  const [, type = "", name = "", label = "", rest = ""] = parsed;
  if (!VAR_TYPES.includes(type)) return undefined;
  const variable: UserCssVar = {
    name,
    type: type as UserCssVar["type"],
    label: unquote(label),
    default: "",
  };
  if (type === "select" || type === "dropdown" || type === "image")
    return withOptions(variable, rest);
  if (type === "number" || type === "range") return withNumber(variable, rest);
  variable.default = unquote(rest);
  return variable;
}

type Option = NonNullable<UserCssVar["options"]>[number] & { starred: boolean };

/** ["a", "b*", "c:Label"] */
function arrayOptions(body: string): Option[] {
  try {
    return (JSON.parse(body) as unknown[]).map((item) => ({
      ...option(String(item)),
      starred: String(item).endsWith("*"),
    }));
  } catch {
    return [];
  }
}

/** {  name "Label" <<<EOT value EOT;  or  name "Label" "value"  }. A star marks the default. */
function blockOptions(body: string): Option[] {
  const inner = body.replace(/^\{|\}$/g, "");
  const pattern =
    /([\w-]+\*?)(?:\s+("[^"]*"|'[^']*'))?\s+(?:<<<EOT\s*([\s\S]*?)\s*EOT;|("[^"]*"|'[^']*'))/g;
  return [...inner.matchAll(pattern)].map((found) => {
    const rawName = found[1] ?? "";
    const rawLabel = unquote(found[2] ?? rawName);
    return {
      name: rawName.replace(/\*$/, ""),
      label: rawLabel.replace(/\*$/, ""),
      value: found[3] ?? unquote(found[4] ?? ""),
      starred: rawName.endsWith("*") || rawLabel.endsWith("*"),
    };
  });
}

function withOptions(variable: UserCssVar, rest: string): UserCssVar {
  const body = rest.trim();
  const options = body.startsWith("[") ? arrayOptions(body) : blockOptions(body);
  variable.options = options.map(({ name, label, value }) => ({ name, label, value }));
  variable.default = (options.find((o) => o.starred) ?? options[0])?.name ?? "";
  return variable;
}

function option(text: string): { name: string; label: string; value: string } {
  const [name = text, label = name] = text.replace(/\*$/, "").split(":");
  return { name, label, value: label };
}

function withNumber(variable: UserCssVar, rest: string): UserCssVar {
  try {
    const values = JSON.parse(rest.trim()) as (number | string | null)[];
    variable.default = String(values[0] ?? "");
    variable.min = typeof values[1] === "number" ? values[1] : undefined;
    variable.max = typeof values[2] === "number" ? values[2] : undefined;
    variable.step = typeof values[3] === "number" ? values[3] : undefined;
    variable.units = typeof values[4] === "string" ? values[4] : undefined;
  } catch {
    variable.default = rest.trim();
  }
  return variable;
}

/** The value a variable has in CSS. */
export function varValue(variable: UserCssVar, chosen: string | undefined): string {
  const value = chosen ?? variable.default;
  if (variable.type === "checkbox") return value === "1" || value === "true" ? "1" : "0";
  if (variable.options) {
    const picked = variable.options.find((o) => o.name === value) ?? variable.options[0];
    return picked?.value ?? "";
  }
  if ((variable.type === "number" || variable.type === "range") && variable.units)
    return value + variable.units;
  return value;
}

/** Splits a userstyle body into sections by its @-moz-document blocks. */
export function styleSections(css: string): StyleSection[] {
  const sections: StyleSection[] = [];
  const outside: string[] = [];
  let index = 0;
  const head = /@-moz-document\s+/g;
  for (let found = head.exec(css); found; found = head.exec(css)) {
    outside.push(css.slice(index, found.index));
    const open = css.indexOf("{", head.lastIndex);
    if (open < 0) break;
    const close = matchingBrace(css, open);
    sections.push({
      sites: documentRules(css.slice(head.lastIndex, open)),
      css: css.slice(open + 1, close).trim(),
    });
    index = close + 1;
    head.lastIndex = index;
  }
  outside.push(css.slice(index));
  const global = stripHeader(outside.join("")).trim();
  if (global) sections.unshift({ sites: [{ type: "all" }], css: global });
  return sections;
}

function stripHeader(css: string): string {
  return css.replace(/\/\*\s*==UserStyle==[\s\S]*?==\/UserStyle==\s*\*\//, "");
}

function matchingBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const char = text[i];
    if (char === "/" && text[i + 1] === "*") i = Math.max(i, text.indexOf("*/", i + 2) + 1);
    else if (char === '"' || char === "'") i = text.indexOf(char, i + 1);
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return i;
    if (i < 0) break;
  }
  return text.length;
}

function documentRules(list: string): SiteRule[] {
  const rules: SiteRule[] = [];
  for (const found of list.matchAll(/(url-prefix|url|domain|regexp)\(\s*(["']?)(.*?)\2\s*\)/g)) {
    const value = (found[3] ?? "").replace(/\\\\/g, "\\");
    const kind = found[1];
    if (kind === "domain") rules.push({ type: "domain", value });
    else if (kind === "url-prefix") rules.push({ type: "prefix", value });
    else if (kind === "url") rules.push({ type: "url", value });
    else rules.push({ type: "regex", value });
  }
  return rules;
}

// ---- Boosts from sources ----------------------------------------------------------------

/** Site rules from a userscript's @match/@include/@exclude lines. */
export function scriptSites(meta: ScriptMeta): { sites: SiteRule[]; excludes: SiteRule[] } {
  const sites: SiteRule[] = [
    ...meta.match.map((value): SiteRule => ({ type: "match", value })),
    ...meta.include.map((value): SiteRule =>
      value === "*" ? { type: "all" } : { type: "glob", value },
    ),
  ];
  const excludes: SiteRule[] = [
    ...meta.excludeMatch.map((value): SiteRule => ({ type: "match", value })),
    ...meta.exclude.map((value): SiteRule => ({ type: "glob", value })),
  ];
  return { sites: sites.length ? sites : [{ type: "all" }], excludes };
}

export function isUserStyle(source: string): boolean {
  return /==UserStyle==/.test(source);
}

/** A new boost (without fetched requires and resources) from a userscript or userstyle. */
export function boostFromSource(source: string, id: string, now = Date.now()): Boost {
  if (isUserStyle(source)) {
    const meta = parseUserStyle(source);
    const sections = styleSections(source);
    return {
      id,
      name: meta.name,
      description: meta.description,
      kind: "userstyle",
      enabled: true,
      sites: unionSites(sections),
      order: 0,
      tags: [],
      created: now,
      updated: now,
      sections,
      source,
      meta,
      varValues: {},
    };
  }
  const meta = parseUserScript(source);
  const { sites, excludes } = scriptSites(meta);
  return {
    id,
    name: meta.name,
    description: meta.description,
    kind: "userscript",
    enabled: true,
    sites,
    excludes,
    order: 0,
    tags: meta.tags,
    created: now,
    updated: now,
    js: source,
    jsWorld: meta.injectInto === "content" ? "isolated" : "page",
    runAt: meta.runAt ?? "document-end",
    allFrames: !meta.noframes,
    source,
    meta,
  };
}

function unionSites(sections: StyleSection[]): SiteRule[] {
  const all = sections.flatMap((section) => section.sites);
  const seen = new Set<string>();
  return all.filter((rule) => {
    const key = `${rule.type}:${rule.value ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Compares dotted versions: 1.10 is newer than 1.9. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string): (number | string)[] =>
    v.split(/[.-]/).map((part) => (/^\d+$/.test(part) ? Number(part) : part));
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i] ?? 0;
    const y = right[i] ?? 0;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x - y;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}
