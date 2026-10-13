const NATIVE_HOST = "com.browser_use_extension.bridge";
const status = document.getElementById("status");
const model = document.getElementById("model");
const connect = document.getElementById("connect-model") as HTMLButtonElement | null;

void chrome.runtime
  .sendMessage({ kind: "bue.status" })
  .then((reply: { connected: boolean; error?: string } | undefined) => {
    if (!status) return;
    if (reply?.connected) {
      status.innerHTML = '<span class="on">● Connected.</span> Agents can use this browser.';
      return;
    }
    status.innerHTML =
      '<span class="off">● Not connected.</span> Run <code>npx browser-use-extension setup</code>, then reopen this popup.';
  });

interface ModelReply {
  ok: boolean;
  connected?: { id: string; name: string }[];
  defaultModel?: { provider: string; model: string } | null;
  url?: string;
  error?: string;
}

function ask(kind: string): Promise<ModelReply> {
  return new Promise((resolve) => {
    chrome.runtime.sendNativeMessage(NATIVE_HOST, { kind }, (reply: ModelReply | undefined) => {
      resolve(reply ?? { ok: false, error: chrome.runtime.lastError?.message ?? "No reply" });
    });
  });
}

// Features that need an AI model use the same sign-in as Pi and the apps built on it.
async function showModel(): Promise<void> {
  if (!model || !connect) return;
  const reply = await ask("model.status");
  if (!reply.ok) {
    model.textContent = "Unavailable until the bridge is set up.";
    return;
  }
  const names = (reply.connected ?? []).map((provider) => provider.name);
  const chosen = reply.defaultModel;
  model.textContent = names.length
    ? `Connected: ${names.join(", ")}${chosen ? ` · default ${chosen.model}` : ""}`
    : "No model connected. Only needed for features that use AI.";
  connect.textContent = names.length ? "Manage models" : "Connect a model";
  connect.hidden = false;
}

connect?.addEventListener("click", async () => {
  connect.disabled = true;
  const reply = await ask("model.login");
  connect.disabled = false;
  if (reply.ok && reply.url) {
    await chrome.tabs.create({ url: reply.url });
    window.close();
  } else if (model)
    model.textContent = `Could not open the sign-in page: ${reply.error ?? "unknown error"}`;
});

void showModel();
