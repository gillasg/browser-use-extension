import less from "less";

// A hidden page for what needs a document: writing to the clipboard, compiling LESS styles.

function copy(data: string, type: string | undefined): void {
  const html = /html/i.test(type ?? "");
  const onCopy = (event: ClipboardEvent): void => {
    event.preventDefault();
    event.clipboardData?.setData(html ? "text/html" : "text/plain", data);
    if (html) event.clipboardData?.setData("text/plain", data.replace(/<[^>]+>/g, ""));
  };
  document.addEventListener("copy", onCopy, { once: true });
  const area = document.createElement("textarea");
  area.value = data;
  document.body.append(area);
  area.select();
  document.execCommand("copy");
  area.remove();
}

chrome.runtime.onMessage.addListener(
  (
    message: { kind?: string; target?: string; data?: string; type?: string; source?: string },
    _sender,
    reply,
  ) => {
    if (message.target !== "offscreen") return false;
    if (message.kind === "offscreen.copy") {
      copy(message.data ?? "", message.type);
      reply({ ok: true });
      return false;
    }
    if (message.kind === "offscreen.less") {
      less.render(message.source ?? "", { javascriptEnabled: false }).then(
        (output) => reply({ ok: true, css: output.css }),
        (error: unknown) =>
          reply({ ok: false, error: error instanceof Error ? error.message : String(error) }),
      );
      return true;
    }
    return false;
  },
);
