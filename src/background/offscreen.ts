// The clipboard and the LESS compiler need a document: a hidden offscreen page does both.

let creating: Promise<void> | undefined;

async function ensureDocument(): Promise<void> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType],
  });
  if (contexts.length) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: "offscreen.html",
      reasons: ["CLIPBOARD" as chrome.offscreen.Reason, "DOM_PARSER" as chrome.offscreen.Reason],
      justification: "Scripts copy text to the clipboard; styles written in LESS are compiled",
    })
    .finally(() => (creating = undefined));
  await creating;
}

export async function copyToClipboard(data: string, type?: string): Promise<void> {
  await ensureDocument();
  await chrome.runtime.sendMessage({ kind: "offscreen.copy", target: "offscreen", data, type });
}

export async function compileLess(source: string): Promise<string> {
  await ensureDocument();
  const reply = (await chrome.runtime.sendMessage({
    kind: "offscreen.less",
    target: "offscreen",
    source,
  })) as { ok: boolean; css?: string; error?: string };
  if (!reply?.ok) throw new Error(`The LESS code did not compile: ${reply?.error ?? "no answer"}`);
  return reply.css ?? "";
}
