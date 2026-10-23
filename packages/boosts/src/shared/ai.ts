import { normalizeBoost } from "./bundle.js";
import { boostText } from "./diff.js";
import type { Boost, ChatTurn, HealthReport, SiteRule } from "./types.js";

// What the model is told, and how its answer becomes a boost. No network here: see models.ts.

export interface PageContext {
  url: string;
  title: string;
  /** A compact outline of the visible page. */
  outline: string;
  /** The element the user pointed at, if any. */
  picked?: {
    selectors: string[];
    similar?: { selector: string; count: number };
    html: string;
    ancestors: string[];
  };
  /** Text the user selected on the page. */
  selection?: string;
}

export interface SiteApiSummary {
  site: string;
  operations: { id: string; summary?: string; method: string; path: string }[];
}

export interface AuthorRequest {
  request: string;
  page: PageContext;
  /** The boost being changed, if any. */
  current?: Boost;
  history?: ChatTurn[];
  /** For repairs: what broke. */
  repair?: { last: HealthReport; lastGood?: HealthReport };
  apis?: SiteApiSummary[];
}

export interface ModelMessage {
  role: "user" | "assistant";
  content: string;
}

export const SYSTEM_PROMPT = `You write Site Boosts: lasting changes a person makes to a website, applied on every visit.

Answer with exactly one JSON object in a \`\`\`json code block, and nothing after it:
{
  "reply": "one or two sentences to the person: what you changed, or a question if the request is unclear",
  "boost": null or {
    "name": "short name, like 'Hide Shorts'",
    "description": "one sentence",
    "sites": [{"type": "domain", "value": "example.com"}],
    "css": "CSS rules",
    "zaps": [{"selector": "CSS selector", "contains": "optional text the element must include"}],
    "look": {"dark": true, "background": "#111", "text": "#eee", "link": "#8af", "font": "Georgia, serif", "fontScale": 1.1, "brightness": 100, "contrast": 100, "saturation": 100, "maxWidth": 760, "hideImages": false},
    "actions": [{"do": "click|remove|fill|select|check|press|scroll|wait|sort|pauseMedia", "selector": "...", "text": "visible text to find the element by", "value": "...", "key": "...", "when": "appear|load", "times": 1}],
    "network": [{"action": "block|allow|redirect|headers", "match": "||ads.example.com^", "regex": "", "domains": ["tracker.example"], "redirect": "https://...", "requestHeaders": [{"name": "Accept-Language", "value": "en-IN"}], "scope": "from-site|to-site|everywhere"}],
    "html": [{"selector": "...", "position": "before|after|prepend|append|replace", "html": "..."}],
    "js": "JavaScript, only when nothing above can do it",
    "jsWorld": "page|isolated"
  }
}

Leave out every field you do not use. Choose the simplest part that works, in this order: css or zaps, look, actions, network, html, then js.

Selectors must survive redesigns and new builds:
- Prefer ids, data-* attributes (data-testid), aria-label, role, name, href fragments, and element structure.
- Never rely on generated class names (css-1q2w3e, sc-AbCd, _a1b2c, jsx-123) or long nth-child chains.
- To hide items marked by text ("Sponsored", "Promoted"), use a zap with the repeated item's selector and "contains".
- Zaps and CSS also apply to elements that appear later; actions with "when": "appear" run on new matches too.

Actions find their element by "selector", by visible "text", or both. "sort" takes "items" (each item), "key" (the element inside each item to sort by), "numeric" and "order". "pauseMedia" stops autoplaying video and audio.

Network rules use declarativeNetRequest urlFilter syntax in "match". "from-site" (the default) limits a rule to requests the boost's sites make; headers default to "to-site".

JavaScript runs after the page loads (in the page's own context with "jsWorld": "page"). It has these helpers:
- SB.onElement(selector, callback): calls back for every matching element, now and when new ones appear.
- SB.waitFor(selector, timeoutMs): resolves with the first match.
- SB.panel({title, html, anchor?, position?}): a styled panel (inside anchor, or floating); returns its root element.
- SB.fetch(url, {method, headers, body, as: "json"|"text"|"html"}): any site, with the person's logins.
- SB.api(site, operationId, params): calls a mapped site's API (listed below when available).
- SB.get(key, fallback) and SB.set(key, value): values kept between visits.
- SB.notify(text), SB.companion(kind, data): asks a companion app to act, for example {kind: "watch", data: {url, price}}.
Never use eval. Keep code short and defensive: elements may be missing.

The sites list decides where the boost runs. Use the current site's domain unless the request says otherwise.
When changing an existing boost, return the whole updated boost, keeping what still works.`;

const clip = (text: string, max: number): string =>
  text.length > max ? text.slice(0, max) + "\n…" : text;

function pageSection(page: PageContext): string {
  const lines = [`Page: ${page.url}`, `Title: ${page.title}`];
  if (page.selection) lines.push(`Selected text: ${clip(page.selection, 500)}`);
  if (page.picked) {
    lines.push(
      "",
      "The person pointed at this element:",
      `Selectors that find it: ${page.picked.selectors.join("  |  ")}`,
      page.picked.similar
        ? `Similar elements: ${page.picked.similar.selector} (${page.picked.similar.count} on the page)`
        : "",
      `Inside: ${page.picked.ancestors.join(" > ")}`,
      "Its HTML:",
      clip(page.picked.html, 3000),
    );
  }
  lines.push("", "Page outline:", clip(page.outline, 14000));
  return lines.filter((line) => line !== "").join("\n");
}

function repairSection(repair: NonNullable<AuthorRequest["repair"]>): string {
  const broken = repair.last.selectors.filter((s) => s.count === 0).map((s) => s.selector);
  const lines = ["This boost stopped working, most likely after the site changed its design."];
  if (broken.length) lines.push(`These selectors now match nothing: ${broken.join("  |  ")}`);
  if (repair.last.errors.length)
    lines.push(`Errors: ${repair.last.errors.slice(0, 5).join(" | ")}`);
  const before =
    repair.lastGood?.selectors.filter((s) => s.sample && broken.includes(s.selector)) ?? [];
  for (const s of before)
    lines.push(
      `Before, ${s.selector} matched: <${s.sample?.tag} ${Object.entries(s.sample?.attrs ?? {})
        .map(([k, v]) => `${k}="${v}"`)
        .join(" ")}> ${s.sample?.text ?? ""}`,
    );
  lines.push(
    "Rewrite only what is broken so the boost does the same thing on the page as it is now.",
  );
  return lines.join("\n");
}

function apiSection(apis: SiteApiSummary[]): string {
  const lines = ["Mapped site APIs you can call with SB.api(site, operationId, params):"];
  for (const api of apis.slice(0, 10)) {
    lines.push(`- ${api.site}`);
    for (const op of api.operations.slice(0, 25))
      lines.push(`  - ${op.id}: ${op.method} ${op.path}${op.summary ? ` (${op.summary})` : ""}`);
  }
  return lines.join("\n");
}

/** The messages for one model call. */
export function authorMessages(input: AuthorRequest): ModelMessage[] {
  const parts = [pageSection(input.page)];
  if (input.apis?.length) parts.push(apiSection(input.apis));
  if (input.current)
    parts.push(
      "The boost as it is now:",
      "```json",
      JSON.stringify(editable(input.current), null, 2),
      "```",
    );
  if (input.repair) parts.push(repairSection(input.repair));
  const history = (input.history ?? [])
    .slice(-8)
    .map((turn): ModelMessage => ({ role: turn.role, content: turn.text }));
  return [
    ...history,
    { role: "user", content: `${parts.join("\n\n")}\n\nRequest: ${input.request}` },
  ];
}

/** The fields the model may change. */
function editable(boost: Boost): Partial<Boost> {
  const { name, description, sites, css, zaps, look, actions, network, html, js, jsWorld } = boost;
  return { name, description, sites, css, zaps, look, actions, network, html, js, jsWorld };
}

export interface AuthorResult {
  reply: string;
  boost?: Boost;
  /** The text diff from the boost before, when changing one. */
  raw: string;
}

/** The first JSON object in a model's answer, fenced or not. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1];
  const candidate = fenced ?? text;
  const start = candidate.indexOf("{");
  if (start < 0) throw new Error("The model did not answer with JSON");
  let depth = 0;
  let quoted = false;
  for (let i = start; i < candidate.length; i++) {
    const char = candidate[i];
    if (quoted) {
      if (char === "\\") i++;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return JSON.parse(candidate.slice(start, i + 1));
  }
  throw new Error("The model's JSON was cut off");
}

/** What a change keeps from the boost being changed: its identity, switches and where it runs. */
function kept(
  input: AuthorRequest,
  proposed: Record<string, unknown>,
  defaultSite: SiteRule,
): Partial<Boost> {
  const base = input.current;
  const sites =
    Array.isArray(proposed.sites) && proposed.sites.length
      ? (proposed.sites as SiteRule[])
      : undefined;
  if (!base)
    return {
      id: undefined,
      kind: "boost",
      enabled: true,
      sites: sites ?? [defaultSite],
      origin: { by: "ai", url: input.page.url, prompt: input.request },
    };
  return {
    id: base.id,
    kind: base.kind,
    created: base.created,
    enabled: base.enabled,
    sites: sites ?? base.sites,
    tags: base.tags,
    order: base.order,
    origin: base.origin,
  };
}

/** Turns the model's answer into a boost, keeping the identity and history of the one being changed. */
export function parseAuthorAnswer(
  text: string,
  input: AuthorRequest,
  defaultSite: SiteRule,
): AuthorResult {
  const answer = extractJson(text) as { reply?: unknown; boost?: unknown };
  const reply = typeof answer.reply === "string" ? answer.reply : "Done.";
  if (!answer.boost || typeof answer.boost !== "object") return { reply, raw: text };
  const proposed = answer.boost as Record<string, unknown>;
  const boost = normalizeBoost({
    ...(input.current ?? {}),
    ...proposed,
    ...kept(input, proposed, defaultSite),
  });
  // Parts the model left out are removed, not kept: it returns the whole boost.
  for (const key of ["css", "zaps", "look", "actions", "network", "html", "js"] as const)
    if (!(key in proposed)) delete boost[key];
  // A userscript's code is its source.
  if (boost.kind === "userscript" && boost.js) boost.source = boost.js;
  const turns: ChatTurn[] = [
    ...(input.history ?? []),
    { role: "user", text: input.request },
    { role: "assistant", text: reply },
  ];
  boost.chat = turns.slice(-12);
  boost.updated = Date.now();
  return { reply, boost, raw: text };
}

/** For the review in the chip: what changed, as text. */
export function changeSummary(
  before: Boost | undefined,
  after: Boost,
): { before: string; after: string } {
  return { before: before ? boostText(before) : "", after: boostText(after) };
}
