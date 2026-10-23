// What an operation is for, in words an app understands. A site's operation ids are its own
// invention (sSearch, getQ, searchProducts); an app wants "the search". Detect the roles from
// what the operation looks like and let overrides say otherwise.

import type { Capability, JsonSchema, Operation } from "../types.js";

const SEARCH_PATH = /(^|\/)(search|autocomplete|suggest|query|find|lookup)(\/|$)/i;
const SEARCH_ID = /(search|autocomplete|suggest|find|lookup)/i;
const SEARCH_PARAM = /^(q|query|term|search|searchterm|keyword|keywords|text|phrase)$/i;
const PRICE_FIELD = /^(price|prices|amount|cost|fare|total|rate|msrp|lowestprice|saleprice)$/i;
const AVAILABILITY_FIELD =
  /^(available|availability|instock|in_stock|stock|stockstatus|showtimes|sessions|seats|isavailable|slot|slots)$/i;

/** Names of the fields a 2xx response carries, down to a readable depth. */
function responseFields(operation: Operation, depth = 3): string[] {
  const schema = Object.entries(operation.responses).find(([code]) => code.startsWith("2"))?.[1]
    ?.schema;
  const names = new Set<string>();
  const walk = (node: JsonSchema | undefined, level: number): void => {
    if (!node || level > depth) return;
    const properties = node.properties as Record<string, JsonSchema> | undefined;
    for (const [name, child] of Object.entries(properties ?? {})) {
      names.add(name);
      walk(child, level + 1);
    }
    walk(node.items as JsonSchema | undefined, level + 1);
    const variants = node.anyOf ?? node.oneOf;
    if (Array.isArray(variants))
      for (const variant of variants) walk(variant as JsonSchema, level + 1);
  };
  walk(schema, 0);
  return [...names];
}

function respondsJson(operation: Operation): boolean {
  const mime = Object.entries(operation.responses).find(([code]) => code.startsWith("2"))?.[1]
    ?.mime;
  return !mime || mime.includes("json");
}

function isList(operation: Operation): boolean {
  if (!respondsJson(operation)) return false;
  if (operation.pagination) return true;
  const schema = Object.entries(operation.responses).find(([code]) => code.startsWith("2"))?.[1]
    ?.schema as JsonSchema | undefined;
  if (!schema) return false;
  if (schema.type === "array") return true;
  const properties = schema.properties as Record<string, JsonSchema> | undefined;
  return Object.values(properties ?? {}).some((value) => value.type === "array");
}

function isDetail(operation: Operation): boolean {
  if (operation.method !== "GET" || !respondsJson(operation) || isList(operation)) return false;
  return operation.params.some((param) => param.in === "path");
}

const VERBS: Partial<Record<Capability, (operation: Operation) => boolean>> = {
  search: (operation) =>
    SEARCH_PATH.test(operation.path) ||
    SEARCH_ID.test(operation.id) ||
    operation.params.some((param) => param.in !== "path" && SEARCH_PARAM.test(param.name)),
  list: isList,
  detail: isDetail,
  price: (operation) => responseFields(operation).some((name) => PRICE_FIELD.test(name)),
  availability: (operation) =>
    responseFields(operation).some((name) => AVAILABILITY_FIELD.test(name)),
};

const ORDER: Capability[] = ["search", "list", "detail", "price", "availability"];

/** The roles an operation can play, in a stable order. */
export function detectCapabilities(operation: Operation): Capability[] {
  // Only a read has a role an app can use: a write is not a search, a listing or a detail page.
  if (operation.role !== "read") return [];
  return ORDER.filter((capability) => VERBS[capability]?.(operation) === true);
}

/** A site's operations by role: the search on this site, its listings, its detail pages. */
export function capabilityIndex(operations: Operation[]): Partial<Record<Capability, string[]>> {
  const index: Partial<Record<Capability, string[]>> = {};
  for (const capability of ORDER) {
    const ids = operations
      .filter((operation) => operation.capabilities?.includes(capability))
      .map((operation) => operation.id);
    if (ids.length) index[capability] = ids;
  }
  return index;
}
