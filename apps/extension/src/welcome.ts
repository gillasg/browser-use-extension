// The page the extension opens when it is first installed: what browserkit is, the one command
// that sets it up, and the MCP entry for the agent. The status light turns green as soon as the
// bridge answers, so a setup that worked is visible without guessing.

const dot = document.getElementById("dot");
const status = document.getElementById("status");

async function check(): Promise<void> {
  const reply = (await chrome.runtime
    .sendMessage({ kind: "bue.status" })
    .catch(() => undefined)) as { connected: boolean; error?: string } | undefined;
  if (!dot || !status) return;
  if (reply?.connected) {
    dot.className = "dot on";
    status.className = "on-text";
    status.textContent = "Connected. Agents can use this browser now.";
    return;
  }
  dot.className = "dot off";
  status.className = "";
  status.textContent = "Not connected yet: run the command above, then wait a moment.";
}

void check();
globalThis.setInterval(() => void check(), 2000);

// Copy buttons: the exact text a user needs, without selecting it by hand.
for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-copy]")) {
  button.addEventListener("click", () => {
    const text = button.dataset.copy ?? "";
    void navigator.clipboard.writeText(text).then(
      () => {
        const label = button.textContent;
        button.textContent = "Copied";
        globalThis.setTimeout(() => (button.textContent = label), 1400);
      },
      () => (button.textContent = "Copy it by hand"),
    );
  });
}
