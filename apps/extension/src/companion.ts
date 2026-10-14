// Other extensions can borrow the model signed in on this computer (Site Boosts writes its
// boosts with it). Each extension is allowed once by the user; the request then goes to the
// native host, which answers with the shared sign-in.

const NATIVE_HOST = "com.browser_use_extension.bridge";
const ALLOWED_KEY = "companionExtensions";
/** Site Boosts, in development builds (its store build asks like any other extension). */
const TRUSTED = new Set(["kcfodpkdfapojnbhkgdlpkikipneejpf"]);
const APPROVAL_TIMEOUT_MS = 60_000;

interface CompanionMessage {
  type?: string;
  kind?: string;
  data?: Record<string, unknown>;
}

type Reply = { ok: true; value: unknown } | { ok: false; error: string };

async function allowedIds(): Promise<Set<string>> {
  const stored = await chrome.storage.local.get(ALLOWED_KEY);
  return new Set([...TRUSTED, ...((stored[ALLOWED_KEY] as string[] | undefined) ?? [])]);
}

/** Asks the user, once per extension, with a notification. */
function askUser(id: string, name: string): Promise<boolean> {
  return new Promise((resolve) => {
    const notificationId = `companion-${id}-${Date.now()}`;
    const done = (allowed: boolean): void => {
      chrome.notifications.onButtonClicked.removeListener(onButton);
      chrome.notifications.onClosed.removeListener(onClosed);
      void chrome.notifications.clear(notificationId);
      resolve(allowed);
    };
    const onButton = (clicked: string, index: number): void => {
      if (clicked === notificationId) done(index === 0);
    };
    const onClosed = (closed: string): void => {
      if (closed === notificationId) done(false);
    };
    chrome.notifications.onButtonClicked.addListener(onButton);
    chrome.notifications.onClosed.addListener(onClosed);
    chrome.notifications.create(notificationId, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icon-128.png"),
      title: "Let another extension use your AI model?",
      message: `${name} wants to use the AI model you signed in to on this computer.`,
      buttons: [{ title: "Allow" }, { title: "Don't allow" }],
      requireInteraction: true,
    });
    setTimeout(() => done(false), APPROVAL_TIMEOUT_MS);
  });
}

async function permitted(id: string): Promise<boolean> {
  if ((await allowedIds()).has(id)) return true;
  const name = await chrome.management
    ?.get(id)
    .then((info) => info.name)
    .catch(() => undefined);
  if (!(await askUser(id, name ?? "An extension"))) return false;
  const stored = await chrome.storage.local.get(ALLOWED_KEY);
  const list = new Set((stored[ALLOWED_KEY] as string[] | undefined) ?? []);
  list.add(id);
  await chrome.storage.local.set({ [ALLOWED_KEY]: [...list] });
  return true;
}

function native(message: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    chrome.runtime.sendNativeMessage(NATIVE_HOST, message, (reply: Record<string, unknown>) => {
      resolve(reply ?? { ok: false, error: chrome.runtime.lastError?.message ?? "No reply" });
    });
  });
}

async function handle(message: CompanionMessage, senderId: string): Promise<Reply> {
  if (message.kind === "ping")
    return { ok: true, value: { name: "Browser Use Extension", features: ["model"] } };
  if (message.kind !== "model.complete")
    return { ok: false, error: `Unsupported request: ${String(message.kind)}` };
  if (!(await permitted(senderId)))
    return { ok: false, error: "The user did not allow this extension to use their model" };
  const reply = await native({ kind: "model.complete", ...(message.data ?? {}) });
  return reply.ok
    ? { ok: true, value: { text: reply.text } }
    : { ok: false, error: String(reply.error) };
}

export function listenToCompanions(): void {
  chrome.runtime.onMessageExternal.addListener((message: CompanionMessage, sender, reply) => {
    if (message?.type !== "site-boosts" || !sender.id) return false;
    void handle(message, sender.id).then(reply, (error: unknown) =>
      reply({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
    return true;
  });
}
