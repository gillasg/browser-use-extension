import { parse } from "../content/html.js";
import type { CssField, CssSchema } from "../types.js";

// Structured records from HTML with CSS selectors: no model, fast, repeatable.

type Node = {
  querySelector(s: string): Node | null;
  querySelectorAll(s: string): Iterable<Node>;
  textContent: string | null;
  innerHTML: string;
  getAttribute(name: string): string | null;
};

function textOf(node: Node): string {
  return (node.textContent ?? "").replace(/\s+/g, " ").trim();
}

function toNumber(text: string): number | null {
  const cleaned = text.replace(/[^\d.,-]/g, "");
  const normalised = /,\d{1,2}$/.test(cleaned)
    ? cleaned.replace(/\./g, "").replace(",", ".")
    : cleaned.replace(/,/g, "");
  const value = parseFloat(normalised);
  return Number.isFinite(value) ? value : null;
}

function select(root: Node, selector: string): Node | null {
  return selector === ":scope" ? root : root.querySelector(selector);
}

function readField(root: Node, field: CssField, base: string): unknown {
  if (field.type === "list") return [...root.querySelectorAll(field.selector)].map(textOf);
  if (field.type === "nested")
    return [...root.querySelectorAll(field.selector)].map((node) =>
      readRecord(node, field.fields ?? [], base),
    );
  const node = select(root, field.selector);
  if (!node) return null;
  if (field.type === "html") return node.innerHTML;
  if (field.type === "number") return toNumber(textOf(node));
  if (field.type === "attr") {
    const value = node.getAttribute(field.attr ?? "href");
    if (value && /^(href|src)$/.test(field.attr ?? "href")) {
      try {
        return new URL(value, base).href;
      } catch {
        return value;
      }
    }
    return value;
  }
  return textOf(node);
}

function readRecord(root: Node, fields: CssField[], base: string): Record<string, unknown> {
  return Object.fromEntries(fields.map((field) => [field.name, readField(root, field, base)]));
}

/** One record, or one per `baseSelector` match. */
export function extractCss(html: string, schema: CssSchema, base: string): unknown {
  const doc = parse(html) as unknown as Node;
  if (!schema.baseSelector) return readRecord(doc, schema.fields, base);
  return [...doc.querySelectorAll(schema.baseSelector)].map((node) =>
    readRecord(node, schema.fields, base),
  );
}
