import { errorText, send } from "../../shared/messages.js";
import { h, when } from "../ui.js";
import { hasUnsavedChanges, renderBoost } from "./boost.js";
import { renderList } from "./list.js";
import { renderSettings } from "./settings.js";

// The manager page: routes #, #boost/<id>[/<tab>], #settings and #console.

const root = document.getElementById("app") as HTMLElement;
const nav = document.getElementById("nav") as HTMLElement;

interface LogEntry {
  at: number;
  level: string;
  boostId?: string;
  url?: string;
  message: string;
}

async function renderConsole(): Promise<void> {
  const entries = await send<LogEntry[]>("log.list");
  root.replaceChildren(
    h(
      "div",
      { className: "row spread" },
      h("h1", { textContent: "Console" }),
      h("button", {
        textContent: "Clear",
        onclick: () => void send("log.clear").then(renderConsole),
      }),
    ),
    entries.length
      ? h(
          "div",
          { className: "stack" },
          ...entries.map((entry) =>
            h(
              "div",
              {
                className:
                  entry.level === "error" ? "error" : entry.level === "warn" ? "warn" : "card",
              },
              h(
                "div",
                { className: "muted" },
                `${when(entry.at)}${entry.url ? ` · ${entry.url}` : ""}`,
                entry.boostId ? " · " : "",
                entry.boostId
                  ? h("a", { href: `#boost/${entry.boostId}`, textContent: "open" })
                  : "",
              ),
              h("pre", {
                style:
                  "margin: 4px 0 0; white-space: pre-wrap; font: 12px ui-monospace, Consolas, monospace",
                textContent: entry.message,
              }),
            ),
          ),
        )
      : h("div", { className: "muted", textContent: "No errors or messages." }),
  );
}

async function route(): Promise<void> {
  const [section = "", id, tab] = location.hash.replace(/^#/, "").split("/");
  for (const link of nav.querySelectorAll("a"))
    link.classList.toggle(
      "active",
      link.getAttribute("href") === `#${section === "boost" ? "" : section}`,
    );
  try {
    if (section === "boost" && id) await renderBoost(root, id, tab);
    else if (section === "settings") await renderSettings(root);
    else if (section === "console") await renderConsole();
    else await renderList(root);
  } catch (error) {
    root.replaceChildren(h("div", { className: "error", textContent: errorText(error) }));
  }
  scrollTo({ top: 0 });
}

addEventListener("hashchange", () => void route());
addEventListener("beforeunload", (event) => {
  if (hasUnsavedChanges()) event.preventDefault();
});
void route();
