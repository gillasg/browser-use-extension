// Values typed in by a password-manager sign-in (passwords, one-time codes). Network recordings
// replace them wherever they show up in a request body, whatever the field is called, so a
// site's login call never lands in a learned API, a HAR file or a trace.
const KEEP_MS = 15 * 60_000;
const secrets = new Map<string, number>();

export function rememberSecrets(values: readonly string[]): void {
  const until = Date.now() + KEEP_MS;
  for (const value of values) if (value.length >= 4) secrets.set(value, until);
}

export function hideSecrets(text: string): string {
  if (!secrets.size) return text;
  const now = Date.now();
  let out = text;
  for (const [value, until] of secrets) {
    if (until < now) {
      secrets.delete(value);
      continue;
    }
    for (const form of new Set([
      value,
      encodeURIComponent(value),
      JSON.stringify(value).slice(1, -1),
    ]))
      out = out.split(form).join("[removed]");
  }
  return out;
}
