// browser.fetch: a request made by the extension itself, with no tab. It runs in the user's
// browser with the user's cookies, so it is fast for pages and APIs that need no JavaScript.
const MAX_TEXT = 5_000_000;
const MAX_BINARY = 16_000_000;
const TIMEOUT_MS = 30_000;

interface FetchRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  json?: unknown;
  credentials?: "include" | "omit";
  /** "auto" (default): JSON when it parses, else text. "base64" for binary files. */
  as?: "auto" | "text" | "base64";
  timeoutMs?: number;
}

export function isFetchRequest(value: Record<string, unknown> | null): boolean {
  return Boolean(value && typeof value.fetch === "object" && value.fetch);
}

export async function fetchCall(value: Record<string, unknown>): Promise<unknown> {
  const request = value.fetch as FetchRequest;
  const url = new URL(String(request.url));
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("browser.fetch only supports http and https addresses");
  const headers = new Headers(request.headers ?? {});
  let body = request.body;
  if (request.json !== undefined) {
    body = JSON.stringify(request.json);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
  }
  const timeout = Math.min(Math.max(Number(request.timeoutMs ?? TIMEOUT_MS), 1000), 120_000);
  const response = await fetch(url, {
    method: request.method ?? "GET",
    headers,
    ...(body !== undefined ? { body } : {}),
    credentials: request.credentials ?? "include",
    redirect: "follow",
    signal: AbortSignal.timeout(timeout),
  });
  const result: Record<string, unknown> = {
    status: response.status,
    ok: response.ok,
    url: response.url,
    headers: Object.fromEntries(response.headers),
  };
  if (request.as === "base64") return { ...result, ...(await base64(response)) };
  const text = await response.text();
  if (request.as !== "text") {
    try {
      return { ...result, json: JSON.parse(text) as unknown };
    } catch {
      // Not JSON: return the text.
    }
  }
  return {
    ...result,
    text: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text,
    ...(text.length > MAX_TEXT ? { truncated: true, length: text.length } : {}),
  };
}

async function base64(response: Response): Promise<Record<string, unknown>> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_BINARY) return { truncated: true, bytes: bytes.byteLength };
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return { base64: btoa(binary), bytes: bytes.byteLength };
}
