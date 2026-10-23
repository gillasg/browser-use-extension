import { describeHealth } from "../shared/health.js";
import { errorText, send } from "../shared/messages.js";
import type { Boost, Look, PagePlan } from "../shared/types.js";
import { h, switchInput, toast } from "./ui.js";

// The toolbar popup: this site's boosts and switches, plain-English requests, zap, and look.

interface TabPlan {
  plan: PagePlan;
  url: string;
  look?: Look;
  presets: { trackers: boolean; autoplay: boolean };
  menu: { boostId: string; id: string; caption: string; title?: string }[];
}

interface Status {
  userScripts: boolean;
  model: boolean;
  companion?: { name: string };
}

const app = document.getElementById("app") as HTMLElement;
let tabId = 0;
let state: TabPlan;
let status: Status;
let reply: { text: string; preview: boolean } | undefined;
let busy = false;

async function currentTab(): Promise<number> {
  const fromQuery = Number(new URLSearchParams(location.search).get("tab"));
  if (fromQuery) return fromQuery;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? 0;
}

async function load(): Promise<void> {
  tabId = await currentTab();
  [state, status] = await Promise.all([
    send<TabPlan>("tab.plan", { tabId }),
    send<Status>("status"),
  ]);
  render();
}

const tab = (message: string, data: Record<string, unknown> = {}): Promise<unknown> =>
  send("tab.send", { tabId, message, data });

function header(): HTMLElement {
  const host = state.plan.host || "This page";
  const on = !state.plan.siteDisabled;
  return h(
    "header",
    { className: "row spread" },
    h(
      "div",
      {},
      h("h1", { textContent: "Site Boosts" }),
      h("div", { className: "muted", textContent: host }),
    ),
    state.plan.host
      ? switchInput(
          on,
          `Boosts on ${host}`,
          (value) => void send("site.toggle", { host: state.plan.host, on: value }).then(load),
        )
      : "",
  );
}

function setupNotes(): HTMLElement[] {
  const notes: HTMLElement[] = [];
  if (!/^(https?|file):/.test(state.url ?? ""))
    notes.push(
      h("div", {
        className: "note",
        textContent: "Boosts work on web pages. Open a site to boost it.",
      }),
    );
  if (state.plan.paused)
    notes.push(h("div", { className: "warn", textContent: "All boosts are paused." }));
  if (!status.userScripts)
    notes.push(
      h(
        "div",
        { className: "warn" },
        "Boosts with JavaScript need one Chrome setting. ",
        h("button", {
          className: "link",
          textContent: "Set up",
          onclick: () => void chrome.tabs.create({ url: "setup.html" }),
        }),
      ),
    );
  return notes;
}

async function ask(text: string): Promise<void> {
  busy = true;
  render();
  try {
    const result = await send<{ reply: string; boost?: Boost }>("author.run", {
      tabId,
      request: text,
    });
    reply = { text: result.reply, preview: Boolean(result.boost) };
  } catch (error) {
    reply = { text: errorText(error), preview: false };
  } finally {
    busy = false;
    render();
  }
}

function askBox(): HTMLElement {
  const input = h("textarea", {
    placeholder: reply?.preview
      ? "Change it…"
      : "Describe a change, like “hide Shorts” or “show unit prices”",
    rows: 2,
  });
  const go = (): void => {
    const text = input.value.trim();
    if (text && !busy) void ask(text);
  };
  input.onkeydown = (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      go();
    }
  };
  const box = h("section", { className: "stack" }, input);
  if (!status.model && !status.companion)
    box.append(
      h(
        "div",
        { className: "muted" },
        "Writing boosts needs a model. ",
        h("button", {
          className: "link",
          textContent: "Connect one",
          onclick: () => void chrome.tabs.create({ url: "manager.html#settings" }),
        }),
      ),
    );
  if (reply) {
    const note = h("div", { className: reply.preview ? "note" : "muted", textContent: reply.text });
    box.append(note);
    if (reply.preview)
      box.append(
        h(
          "div",
          { className: "row" },
          h("button", {
            className: "primary",
            textContent: "Keep",
            onclick: () =>
              void send("author.keep", { tabId }).then(
                () => ((reply = undefined), toast("Saved"), load()),
              ),
          }),
          h("button", {
            textContent: "Discard",
            onclick: () =>
              void send("author.discard", { tabId }).then(() => ((reply = undefined), load())),
          }),
        ),
      );
  }
  box.append(
    h(
      "div",
      { className: "row" },
      h("button", {
        className: "primary",
        textContent: busy ? "Writing…" : reply?.preview ? "Change" : "Boost it",
        disabled: busy,
        onclick: go,
      }),
      h("button", {
        textContent: "Point at it",
        title: "Click the part of the page to change, then describe it",
        onclick: () =>
          void tab("picker.point")
            .catch(() => undefined)
            .then(() => window.close()),
      }),
      h("button", {
        textContent: "Zap",
        title: "Click things to hide them (Alt+Shift+Z)",
        onclick: () =>
          void tab("picker.zap")
            .catch(() => undefined)
            .then(() => window.close()),
      }),
    ),
  );
  return box;
}

function quickSwitches(): HTMLElement {
  const host = state.plan.host;
  const look = state.look ?? {};
  const row = (label: string, on: boolean, change: (on: boolean) => void): HTMLElement =>
    h(
      "label",
      { className: "row spread" },
      h("span", { textContent: label }),
      switchInput(on, label, change),
    );
  return h(
    "section",
    { className: "stack card" },
    row("Dark mode", Boolean(look.dark), (on) => void saveLook({ ...look, dark: on || undefined })),
    row(
      "Block ads and trackers",
      state.presets.trackers,
      (on) => void send("preset.set", { host, preset: "trackers", on }).then(load),
    ),
    row(
      "Stop autoplaying video",
      state.presets.autoplay,
      (on) => void send("preset.set", { host, preset: "autoplay", on }).then(load),
    ),
    lookControls(),
  );
}

async function saveLook(look: Look): Promise<void> {
  await send("look.set", { host: state.plan.host, look, tabId });
  await load();
}

function slider(
  label: string,
  key: "brightness" | "contrast" | "saturation",
  look: Look,
): HTMLElement {
  const input = h("input", {
    type: "range",
    min: "40",
    max: "160",
    value: String(look[key] ?? 100),
  });
  input.oninput = () => void tab("look.preview", { look: { ...look, [key]: Number(input.value) } });
  input.onchange = () =>
    void saveLook({
      ...look,
      [key]: Number(input.value) === 100 ? undefined : Number(input.value),
    });
  return h("label", { className: "field" }, label, input);
}

function colour(label: string, key: "background" | "text" | "link", look: Look): HTMLElement {
  const input = h("input", {
    type: "color",
    value: look[key] ?? (key === "background" ? "#ffffff" : key === "link" ? "#3a5ccc" : "#1b1b1f"),
  });
  input.oninput = () => void tab("look.preview", { look: { ...look, [key]: input.value } });
  input.onchange = () => void saveLook({ ...look, [key]: input.value });
  const clear = h("button", {
    className: "link",
    textContent: "×",
    title: "Reset",
    onclick: () => void saveLook({ ...look, [key]: undefined }),
  });
  return h("label", { className: "row" }, input, label, look[key] ? clear : "");
}

const FONTS = [
  "",
  "system-ui, sans-serif",
  "Georgia, serif",
  "'Iowan Old Style', 'Palatino Linotype', serif",
  "Verdana, sans-serif",
  "'Atkinson Hyperlegible', Verdana, sans-serif",
  "ui-monospace, Consolas, monospace",
];

function lookControls(): HTMLElement {
  const look = state.look ?? {};
  const font = h(
    "select",
    {},
    ...FONTS.map((value) =>
      h("option", {
        value,
        textContent: value ? (value.split(",")[0] ?? value).replace(/'/g, "") : "Site's own font",
        selected: (look.font ?? "") === value,
      }),
    ),
  );
  font.onchange = () => void saveLook({ ...look, font: font.value || undefined });
  const size = h("input", {
    type: "range",
    min: "0.8",
    max: "1.6",
    step: "0.05",
    value: String(look.fontScale ?? 1),
  });
  size.oninput = () =>
    void tab("look.preview", { look: { ...look, fontScale: Number(size.value) } });
  size.onchange = () =>
    void saveLook({
      ...look,
      fontScale: Number(size.value) === 1 ? undefined : Number(size.value),
    });
  const width = h("input", {
    type: "number",
    min: "400",
    max: "2000",
    step: "20",
    placeholder: "Full width",
    value: look.maxWidth ? String(look.maxWidth) : "",
  });
  width.onchange = () => void saveLook({ ...look, maxWidth: Number(width.value) || undefined });
  return h(
    "details",
    {},
    h("summary", { textContent: "Colours, fonts and layout" }),
    h(
      "div",
      { className: "stack", style: "margin-top: 8px" },
      h(
        "div",
        { className: "row", style: "flex-wrap: wrap; gap: 12px" },
        colour("Background", "background", look),
        colour("Text", "text", look),
        colour("Links", "link", look),
      ),
      h("label", { className: "field" }, "Font", font),
      h("label", { className: "field" }, "Size", size),
      slider("Brightness", "brightness", look),
      slider("Contrast", "contrast", look),
      slider("Saturation", "saturation", look),
      h("label", { className: "field" }, "Readable column width (px)", width),
      h(
        "label",
        { className: "row spread" },
        "Hide images",
        switchInput(
          Boolean(look.hideImages),
          "Hide images",
          (on) => void saveLook({ ...look, hideImages: on || undefined }),
        ),
      ),
      h("button", { textContent: "Reset the look", onclick: () => void saveLook({}) }),
    ),
  );
}

function boostList(): HTMLElement {
  const { plan } = state;
  const section = h("section", { className: "stack" }, h("h2", { textContent: "On this page" }));
  if (!plan.boosts.length)
    section.append(h("div", { className: "muted", textContent: "No boosts here yet." }));
  for (const boost of plan.boosts) {
    const health = plan.health[boost.id];
    const on = plan.active.includes(boost.id);
    section.append(
      h(
        "div",
        { className: "row spread" },
        h("span", {
          className: `dot ${health?.status ?? ""}`,
          title: health ? describeHealth(health) : "",
        }),
        h("span", {
          style:
            "flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap",
          textContent: boost.name,
          title: boost.description ?? "",
        }),
        h("button", {
          className: "link",
          textContent: "Edit",
          onclick: () => void chrome.tabs.create({ url: `manager.html#boost/${boost.id}` }),
        }),
        switchInput(
          on,
          `${boost.name} on this site`,
          (value) =>
            void send("site.boost", { host: plan.host, id: boost.id, on: value }).then(load),
        ),
      ),
    );
  }
  for (const command of state.menu)
    section.append(
      h("button", {
        textContent: command.caption,
        title: command.title ?? "",
        onclick: () =>
          void send("menu.run", { tabId, boostId: command.boostId, id: command.id }).then(() =>
            window.close(),
          ),
      }),
    );
  return section;
}

function footer(): HTMLElement {
  return h(
    "footer",
    { className: "row spread" },
    h("button", {
      textContent: "Manage boosts",
      onclick: () => void chrome.tabs.create({ url: "manager.html" }),
    }),
    h(
      "label",
      { className: "row muted" },
      "Pause all",
      switchInput(
        state.plan.paused,
        "Pause all boosts",
        (paused) => void send("settings.set", { patch: { paused } }).then(load),
      ),
    ),
  );
}

function render(): void {
  const web = /^(https?|file):/.test(state.url ?? "");
  app.replaceChildren(
    header(),
    ...setupNotes(),
    ...(web ? [askBox(), quickSwitches(), boostList()] : []),
    footer(),
  );
}

void load().catch((error: unknown) =>
  app.replaceChildren(h("div", { className: "error", textContent: errorText(error) })),
);
