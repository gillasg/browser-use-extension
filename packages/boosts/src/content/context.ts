import type { PageContext } from "../shared/ai.js";
import { descriptor, isGeneratedClass, selectorsFor, similarSelector } from "./target.js";

// A compact outline of the page for the model: structure, stable hooks and a little text.

const SKIP = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "TEMPLATE",
  "LINK",
  "META",
  "PATH",
  "DEFS",
  "SITE-BOOSTS-CHIP",
  "SITE-BOOSTS-PICKER",
]);
const KEEP_ATTRIBUTES = [
  "role",
  "aria-label",
  "data-testid",
  "name",
  "type",
  "placeholder",
  "href",
  "title",
  "alt",
];

function hidden(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.hidden) return true;
  const style = getComputedStyle(el);
  return style.display === "none" || style.visibility === "hidden";
}

function label(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const parts = [tag];
  if (el.id) parts.push(`#${el.id}`);
  const classes = [...el.classList]
    .slice(0, 4)
    .map((c) => (isGeneratedClass(c) ? `.${c}(generated)` : `.${c}`));
  parts.push(...classes);
  for (const name of KEEP_ATTRIBUTES) {
    const value = el.getAttribute(name);
    if (value) parts.push(`[${name}="${value.slice(0, 60)}"]`);
  }
  return parts.join("");
}

function ownText(el: Element): string {
  let text = "";
  for (const node of el.childNodes)
    if (node.nodeType === Node.TEXT_NODE) text += node.textContent ?? "";
  return text.replace(/\s+/g, " ").trim().slice(0, 80);
}

interface State {
  out: string[];
  size: number;
  max: number;
}

/** Wrappers with one child and nothing of their own add nothing: their level is skipped. */
const isPassThrough = (el: Element, text: string): boolean =>
  !text &&
  el.children.length === 1 &&
  !el.id &&
  !el.getAttribute("role") &&
  !el.getAttribute("aria-label");

function walk(el: Element, depth: number, state: State): void {
  if (state.size > state.max || SKIP.has(el.tagName) || hidden(el)) return;
  const text = ownText(el);
  const passThrough = isPassThrough(el, text);
  if (!passThrough) {
    const line = `${"  ".repeat(depth)}${label(el)}${text ? ` "${text}"` : ""}`;
    state.out.push(line);
    state.size += line.length + 1;
  }
  walkChildren([...el.children], passThrough ? depth : depth + 1, state);
}

/** Children in order; runs of alike siblings are cut to two and a count. */
function walkChildren(children: Element[], next: number, state: State): void {
  let lastKey = "";
  let repeats = 0;
  for (const child of children) {
    const key = descriptor(child);
    repeats = key === lastKey ? repeats + 1 : 0;
    lastKey = key;
    if (repeats === 2) {
      const total = children.filter((c) => descriptor(c) === key).length;
      state.out.push(`${"  ".repeat(next)}… ${total - 2} more like ${key}`);
    }
    if (repeats >= 2) continue;
    walk(child, next, state);
  }
}

export function pageOutline(max = 14000): string {
  const state: State = { out: [], size: 0, max };
  if (document.body) walk(document.body, 0, state);
  return state.out.join("\n");
}

function ancestors(el: Element): string[] {
  const list: string[] = [];
  for (
    let current = el.parentElement;
    current && current !== document.body && list.length < 6;
    current = current.parentElement
  )
    list.unshift(descriptor(current));
  return list;
}

let picked: Element | undefined;

/** Remembers the element the person pointed at, for the next request. */
export function setPicked(el: Element | undefined): void {
  picked = el;
}

export function pageContext(): PageContext {
  const context: PageContext = {
    url: location.href,
    title: document.title,
    outline: pageOutline(),
  };
  const selection = getSelection()?.toString().trim();
  if (selection) context.selection = selection.slice(0, 1000);
  if (picked?.isConnected) {
    context.picked = {
      selectors: selectorsFor(picked),
      similar: similarSelector(picked),
      html: picked.outerHTML.slice(0, 3000),
      ancestors: ancestors(picked),
    };
  }
  return context;
}
