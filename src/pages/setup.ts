import { send } from "../shared/messages.js";
import { h } from "./ui.js";

// Guided setup for the Chrome settings Site Boosts needs, ticked off as they are done.

interface Status {
  userScripts: boolean;
  model: boolean;
  companion?: { name: string };
  id: string;
}

const app = document.getElementById("app") as HTMLElement;

function chromeMajor(): number {
  return Number(/Chrome\/(\d+)/.exec(navigator.userAgent)?.[1] ?? 0);
}

function step(done: boolean, title: string, ...body: (Node | string)[]): HTMLElement {
  return h(
    "section",
    { className: "card stack" },
    h(
      "div",
      { className: "row" },
      h("span", { className: `dot ${done ? "ok" : "broken"}` }),
      h("h2", { textContent: title }),
      done ? h("span", { className: "muted", textContent: "Done" }) : "",
    ),
    ...(done ? [] : body),
  );
}

async function render(): Promise<void> {
  const status = await send<Status>("status");
  const siteAccess = await chrome.permissions.contains({ origins: ["<all_urls>"] });
  const details = `chrome://extensions/?id=${status.id}`;
  const open = (url: string): void => void chrome.tabs.create({ url });
  const toggleName =
    chromeMajor() >= 138
      ? "Allow User Scripts"
      : "Developer mode (at the top right of the Extensions page)";
  app.replaceChildren(
    h("h1", { textContent: "Set up Site Boosts" }),
    h("div", {
      className: "muted",
      textContent:
        "Styles, zaps, look and network boosts work right away. These steps unlock the rest.",
    }),
    step(
      status.userScripts,
      "Allow boosts with JavaScript",
      h("div", {
        textContent: `Chrome keeps extension scripts off until you allow them. Open Site Boosts' details and switch on “${toggleName}”.`,
      }),
      h("button", {
        className: "primary",
        textContent: "Open the details page",
        onclick: () => open(chromeMajor() >= 138 ? details : "chrome://extensions"),
      }),
      h("div", { className: "muted", textContent: "This page notices when it is done." }),
    ),
    step(
      siteAccess,
      "Let it work on every site",
      h("div", {
        textContent: "Site access is limited, so boosts only run where you allowed them.",
      }),
      h("button", {
        className: "primary",
        textContent: "Allow on all sites",
        onclick: () =>
          void chrome.permissions.request({ origins: ["<all_urls>"] }).then(() => render()),
      }),
    ),
    step(
      status.model || Boolean(status.companion),
      "Connect a model (optional)",
      h("div", {
        textContent:
          "Needed only to write boosts from plain English and repair them after redesigns. Use your own key from any major provider, or a local model.",
      }),
      h("button", { textContent: "Connect a model", onclick: () => open("manager.html#settings") }),
    ),
    h(
      "section",
      { className: "card stack" },
      h("h2", { textContent: "Tips" }),
      h("div", {
        textContent: "Pin Site Boosts to the toolbar: click the puzzle piece, then the pin.",
      }),
      h(
        "div",
        {},
        "Alt+Shift+Z hides things on any page; Alt+Shift+B opens the ⚡ panel. ",
        h("button", {
          className: "link",
          textContent: "Change shortcuts",
          onclick: () => open("chrome://extensions/shortcuts"),
        }),
      ),
      h("div", { textContent: "Links to .user.js and .user.css files open an install page." }),
    ),
  );
}

void render();
setInterval(() => void render(), 2000);
