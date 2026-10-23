// Values with a life: a stream ticket, a signed URL, an upload token. The model has to say so,
// because a caller cannot tell by looking, and reusing one is a bug that surfaces minutes later.
//
// Two ways to know: the same call twice answered with a different value (it was minted for that
// call), or the value carries its own expiry (a URL with token and expires parameters).

import type { Json, Sample } from "../types.js";

export type VolatileReason = "changed" | "ticket" | "expires";

export interface VolatileField {
  /** JSON pointer into the response body. */
  pointer: string;
  reason: VolatileReason;
}

/** A URL that carries its own ticket: the part that makes it work once and then stop. */
const TICKET_URL = /[?&](t|token|sig|signature|expires|exp|hmac|key|policy)=/i;
const EXPIRY_NAME =
  /^(expires|expiresat|expires_at|expiry|expiryat|expiration|ttl|validuntil|valid_until)$/i;
const MAX_FIELDS = 50;

/** JSON pointers whose values differ between two calls that asked exactly the same thing. */
function changedPointers(samples: Sample[]): string[] {
  const groups = new Map<string, Sample[]>();
  for (const sample of samples) {
    const key = `${sample.method} ${sample.url} ${sample.requestBody ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), sample]);
  }
  const changed = new Set<string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const maps = group.map((sample) => leaves(sample.responseBody)).filter((map) => map.size);
    if (maps.length < 2) continue;
    const [first] = maps;
    if (!first) continue;
    for (const [pointer, value] of first)
      if (maps.slice(1).every((map) => map.has(pointer) && map.get(pointer) !== value))
        changed.add(pointer);
  }
  return [...changed];
}

/** Scalar leaves at non-array paths: an array's index is not a field, and its items differ by job. */
function leaves(body: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!body) return map;
  let parsed: Json;
  try {
    parsed = JSON.parse(body) as Json;
  } catch {
    return map;
  }
  const walk = (value: Json, pointer: string): void => {
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) walk(item, `${pointer}/${index}`);
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) walk(child, `${pointer}/${key}`);
      return;
    }
    if (!pointer.includes("/") || /\/\d+\//.test(pointer)) return;
    map.set(pointer, String(value));
  };
  walk(parsed, "");
  return map;
}

/** Fields whose value carries an expiry, or whose name says it is one. */
function flaggedPointers(samples: Sample[]): VolatileField[] {
  const found = new Map<string, VolatileField>();
  for (const sample of samples) {
    if (!sample.responseBody) continue;
    let parsed: Json;
    try {
      parsed = JSON.parse(sample.responseBody) as Json;
    } catch {
      continue;
    }
    const walk = (value: Json, pointer: string): void => {
      if (Array.isArray(value)) {
        for (const [index, item] of value.entries()) walk(item, `${pointer}/${index}`);
        return;
      }
      if (value && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) {
          if (EXPIRY_NAME.test(key))
            found.set(`${pointer}/${key}`, { pointer: `${pointer}/${key}`, reason: "expires" });
          walk(child, `${pointer}/${key}`);
        }
        return;
      }
      if (typeof value === "string" && TICKET_URL.test(value))
        found.set(pointer, { pointer, reason: "ticket" });
    };
    walk(parsed, "");
  }
  return [...found.values()];
}

/** Everything about a response that cannot be stored and reused, most specific reason first. */
export function volatileFields(samples: Sample[]): VolatileField[] {
  const found = new Map<string, VolatileField>();
  for (const pointer of changedPointers(samples))
    found.set(pointer, { pointer, reason: "changed" });
  for (const field of flaggedPointers(samples))
    if (!found.has(field.pointer)) found.set(field.pointer, field);
  return [...found.values()].slice(0, MAX_FIELDS);
}
