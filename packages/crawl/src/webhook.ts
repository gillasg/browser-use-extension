import { createHmac } from "node:crypto";
import type { CrawlEvent, CrawlOptions } from "./types.js";

// Webhooks: each event is POSTed as JSON, signed with HMAC-SHA256 when a secret is set
// (header x-browser-crawl-signature: sha256=<hex of the body>).

export function signature(body: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

export async function sendWebhook(
  webhook: NonNullable<CrawlOptions["webhook"]>,
  event: CrawlEvent,
): Promise<void> {
  if (webhook.events && !webhook.events.includes(event.type)) return;
  const body = JSON.stringify(event);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-browser-crawl-event": event.type,
  };
  if (webhook.secret) headers["x-browser-crawl-signature"] = signature(body, webhook.secret);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(webhook.url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) return;
    } catch {
      // Retried below.
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
  }
}
