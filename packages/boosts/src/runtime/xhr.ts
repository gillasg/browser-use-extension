import type { Transport } from "./transport.js";

// GM_xmlhttpRequest on top of the service worker's fetch: any site the script may connect to,
// with the person's cookies, and the classic callback shape.

export interface XhrDetails {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  data?: unknown;
  responseType?: "" | "text" | "json" | "blob" | "arraybuffer" | "document" | "stream";
  timeout?: number;
  anonymous?: boolean;
  overrideMimeType?: string;
  user?: string;
  password?: string;
  context?: unknown;
  redirect?: "follow" | "error" | "manual";
  onload?: (response: XhrResponse) => void;
  onerror?: (response: XhrResponse) => void;
  onabort?: (response: XhrResponse) => void;
  ontimeout?: (response: XhrResponse) => void;
  onprogress?: (response: XhrResponse) => void;
  onreadystatechange?: (response: XhrResponse) => void;
  onloadstart?: (response: XhrResponse) => void;
  onloadend?: (response: XhrResponse) => void;
}

export interface XhrResponse {
  readyState: number;
  status: number;
  statusText: string;
  responseHeaders: string;
  finalUrl: string;
  response: unknown;
  responseText: string;
  responseXML: Document | null;
  context?: unknown;
  loaded?: number;
  total?: number;
  lengthComputable?: boolean;
  error?: string;
}

interface WireResponse {
  status: number;
  statusText: string;
  headers: string;
  finalUrl: string;
  /** Base64 of the body. */
  body?: string;
  mime: string;
  loaded?: number;
  total?: number;
  error?: string;
}

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Request bodies travel as JSON: strings stay strings, binary becomes base64, forms become entries. */
export async function encodeBody(data: unknown): Promise<unknown> {
  if (data === undefined || data === null || typeof data === "string") return data;
  if (data instanceof URLSearchParams)
    return {
      kind: "text",
      text: data.toString(),
      type: "application/x-www-form-urlencoded;charset=UTF-8",
    };
  if (data instanceof Blob)
    return {
      kind: "bytes",
      base64: toBase64(new Uint8Array(await data.arrayBuffer())),
      type: data.type,
    };
  if (data instanceof ArrayBuffer) return { kind: "bytes", base64: toBase64(new Uint8Array(data)) };
  if (ArrayBuffer.isView(data))
    return {
      kind: "bytes",
      base64: toBase64(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)),
    };
  if (data instanceof FormData) {
    const entries: unknown[] = [];
    for (const [name, value] of data.entries())
      entries.push(
        typeof value === "string"
          ? { name, value }
          : {
              name,
              file: toBase64(new Uint8Array(await value.arrayBuffer())),
              filename: value.name,
              type: value.type,
            },
      );
    return { kind: "form", entries };
  }
  return { kind: "text", text: JSON.stringify(data), type: "application/json" };
}

function decode(
  wire: WireResponse,
  type: XhrDetails["responseType"],
): { response: unknown; text: string; xml: Document | null } {
  const bytes = wire.body ? fromBase64(wire.body) : new Uint8Array();
  const text = type === "blob" || type === "arraybuffer" ? "" : new TextDecoder().decode(bytes);
  if (type === "arraybuffer") return { response: bytes.buffer, text, xml: null };
  if (type === "blob") return { response: new Blob([bytes], { type: wire.mime }), text, xml: null };
  if (type === "json") {
    try {
      return { response: JSON.parse(text), text, xml: null };
    } catch {
      return { response: undefined, text, xml: null };
    }
  }
  const isMarkup = /xml|html/.test(wire.mime);
  const xml = type === "document" || isMarkup ? parseMarkup(text, wire.mime) : null;
  return { response: type === "document" ? xml : text, text, xml };
}

function parseMarkup(text: string, mime: string): Document | null {
  try {
    return new DOMParser().parseFromString(text, /html/.test(mime) ? "text/html" : "text/xml");
  } catch {
    return null;
  }
}

const NOTHING_YET: WireResponse = {
  status: 0,
  statusText: "",
  headers: "",
  finalUrl: "",
  mime: "",
};

function makeResponse(
  details: XhrDetails,
  received: WireResponse | undefined,
  readyState: number,
): XhrResponse {
  const wire = received ?? NOTHING_YET;
  const decoded =
    received && readyState === 4
      ? decode(received, details.responseType)
      : { response: undefined, text: "", xml: null };
  return {
    readyState,
    status: wire.status,
    statusText: wire.statusText,
    responseHeaders: wire.headers,
    finalUrl: wire.finalUrl || details.url,
    response: decoded.response,
    responseText: decoded.text,
    responseXML: decoded.xml,
    context: details.context,
    loaded: wire.loaded,
    total: wire.total,
    lengthComputable: wire.total !== undefined,
    error: wire.error,
  };
}

type Handler = keyof Pick<
  XhrDetails,
  | "onload"
  | "onerror"
  | "onabort"
  | "ontimeout"
  | "onprogress"
  | "onreadystatechange"
  | "onloadstart"
  | "onloadend"
>;

export function xmlHttpRequest(
  transport: Transport,
  details: XhrDetails,
  report: (error: unknown) => void,
): { abort(): void; promise: Promise<XhrResponse> } {
  let cancel: (() => void) | undefined;
  let aborted = false;
  let last: WireResponse | undefined;
  const fire = (name: Handler, response: XhrResponse): void => {
    try {
      details[name]?.(response);
    } catch (error) {
      report(error);
    }
  };
  const promise = new Promise<XhrResponse>((resolve, reject) => {
    void encodeBody(details.data).then((data) => {
      if (aborted) return;
      // Callbacks and the context object stay in the page.
      const rest = Object.fromEntries(
        Object.entries(details).filter(
          ([key, value]) => typeof value !== "function" && key !== "context",
        ),
      );
      fire("onloadstart", makeResponse(details, undefined, 1));
      cancel = transport.stream("xhr", { ...rest, data }, (event, payload) => {
        const wire = payload as WireResponse | undefined;
        if (wire) last = wire;
        if (event === "headers") fire("onreadystatechange", makeResponse(details, wire, 2));
        else if (event === "progress") fire("onprogress", makeResponse(details, wire, 3));
        else if (event === "load") {
          const response = makeResponse(details, wire, 4);
          fire("onreadystatechange", response);
          fire("onload", response);
          fire("onloadend", response);
          resolve(response);
        } else if (event === "error" || event === "timeout") {
          const response = makeResponse(details, wire ?? last, 4);
          fire(event === "timeout" ? "ontimeout" : "onerror", response);
          fire("onloadend", response);
          reject(Object.assign(new Error(wire?.error ?? event), { response }));
        }
      });
    });
  });
  promise.catch(() => undefined);
  return {
    promise,
    abort() {
      aborted = true;
      cancel?.();
      fire("onabort", makeResponse(details, last, 4));
    },
  };
}
