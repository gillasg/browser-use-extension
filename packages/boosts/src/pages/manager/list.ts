import { describeHealth } from "../../shared/health.js";
import { describeRule } from "../../shared/match.js";
import { errorText, send } from "../../shared/messages.js";
import type { Boost, Health } from "../../shared/types.js";
import { h, switchInput, toast, when } from "../ui.js";

// The dashboard: every boost, script and style, with search, filters, switches and run order.

const KIND_LABEL: Record<Boost["kind"], string> = {
  boost: "Boost",
  userscript: "Script",
  userstyle: "Style",
};

let filter = { text: "", kind: "all", tag: "" };

const STARTERS: Record<string, (name: string) => string> = {
  userscript: (name) => `// ==UserScript==
// @name        ${name}
// @namespace   site-boosts
// @version     1.0
// @match       https://example.com/*
// @grant       none
// ==/UserScript==

`,
  userstyle: (name) => `/* ==UserStyle==
@name        ${name}
@namespace   site-boosts
@version     1.0
@preprocessor default
==/UserStyle== */

@-moz-document domain("example.com") {
}
`,
};

async function create(kind: Boost["kind"]): Promise<void> {
  let boost: Boost;
  if (kind === "boost")
    boost = await send<Boost>("boost.create", {
      boost: { name: "New boost", kind, sites: [{ type: "domain", value: "example.com" }] },
    });
  else
    boost = await send<Boost>("install.confirm", {
      prepared: await send("install.prepare", {
        source: STARTERS[kind]?.(
          `New ${kind === "userscript" ? "script" : "style"} ${new Date().toLocaleString()}`,
        ),
      }),
    });
  location.hash = `boost/${boost.id}`;
}

function matches(boost: Boost): boolean {
  if (filter.kind !== "all" && boost.kind !== filter.kind) return false;
  if (filter.tag && !boost.tags.includes(filter.tag)) return false;
  const text = filter.text.toLowerCase();
  if (!text) return true;
  return [
    boost.name,
    boost.description ?? "",
    ...boost.sites.map(describeRule),
    ...boost.tags,
  ].some((part) => part.toLowerCase().includes(text));
}

function toolbar(boosts: Boost[], rerender: () => void): HTMLElement {
  const search = h("input", {
    type: "search",
    placeholder: "Search boosts, sites and tags",
    value: filter.text,
  });
  search.oninput = () => {
    filter = { ...filter, text: search.value };
    rerender();
  };
  const kind = h(
    "select",
    {},
    ...[
      ["all", "Everything"],
      ["boost", "Boosts"],
      ["userscript", "Scripts"],
      ["userstyle", "Styles"],
    ].map(([value, label]) =>
      h("option", { value, textContent: label, selected: filter.kind === value }),
    ),
  );
  kind.onchange = () => {
    filter = { ...filter, kind: kind.value };
    rerender();
  };
  const tags = [...new Set(boosts.flatMap((b) => b.tags))].sort();
  const tag = h(
    "select",
    {},
    h("option", { value: "", textContent: "Any tag" }),
    ...tags.map((t) => h("option", { value: t, textContent: t, selected: filter.tag === t })),
  );
  tag.onchange = () => {
    filter = { ...filter, tag: tag.value };
    rerender();
  };
  return h(
    "div",
    { className: "row", style: "flex-wrap: wrap" },
    h("div", { style: "flex: 1; min-width: 220px" }, search),
    kind,
    tag,
  );
}

function actions(): HTMLElement {
  const install = (): void => {
    const url = prompt("Address of a .user.js or .user.css file");
    if (url) location.href = `install.html?url=${encodeURIComponent(url)}`;
  };
  return h(
    "div",
    { className: "row", style: "flex-wrap: wrap" },
    h("button", {
      className: "primary",
      textContent: "New boost",
      onclick: () => void create("boost"),
    }),
    h("button", { textContent: "New script", onclick: () => void create("userscript") }),
    h("button", { textContent: "New style", onclick: () => void create("userstyle") }),
    h("button", { textContent: "Install from a link", onclick: install }),
    h("button", {
      textContent: "Check for updates",
      onclick: () =>
        void send<{ name: string; applied: boolean; to?: string; error?: string }[]>(
          "updates.check",
          { apply: true },
        ).then(
          (results) =>
            toast(
              results.length
                ? results
                    .map((r) => (r.error ? `${r.name}: ${r.error}` : `${r.name} → ${r.to}`))
                    .join(" · ")
                : "Everything is up to date",
            ),
          (error: unknown) => toast(errorText(error)),
        ),
    }),
  );
}

function row(
  boost: Boost,
  health: Health | undefined,
  index: number,
  all: Boost[],
  reload: () => void,
): HTMLElement {
  const move = async (delta: number): Promise<void> => {
    const ids = all.map((b) => b.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(Math.max(0, index + delta), 0, moved as string);
    await send("boost.order", { ids });
    reload();
  };
  return h(
    "div",
    { className: "card row", style: "gap: 12px" },
    switchInput(
      boost.enabled,
      `${boost.name} on or off`,
      (enabled) => void send("boost.toggle", { id: boost.id, enabled }).then(reload),
    ),
    h("span", {
      className: `dot ${health?.status ?? ""}`,
      title: health ? describeHealth(health) : "Not seen yet",
    }),
    h(
      "a",
      {
        href: `#boost/${boost.id}`,
        style: "flex: 1; min-width: 0; text-decoration: none; color: inherit",
      },
      h(
        "div",
        { className: "row", style: "gap: 6px" },
        h("strong", { textContent: boost.name }),
        h("span", { className: "tag", textContent: KIND_LABEL[boost.kind] }),
        boost.meta?.version
          ? h("span", { className: "muted", textContent: `v${boost.meta.version}` })
          : "",
      ),
      h("div", {
        className: "muted",
        textContent: `${boost.sites.map(describeRule).slice(0, 3).join(", ")}${boost.sites.length > 3 ? "…" : ""} · ${when(boost.updated)}`,
      }),
    ),
    h("button", {
      className: "link",
      textContent: "↑",
      title: "Run earlier",
      onclick: () => void move(-1),
    }),
    h("button", {
      className: "link",
      textContent: "↓",
      title: "Run later",
      onclick: () => void move(1),
    }),
  );
}

export async function renderList(root: HTMLElement): Promise<void> {
  const { boosts, health } = await send<{ boosts: Boost[]; health: Record<string, Health> }>(
    "boosts.list",
  );
  const list = h("div", { className: "stack" });
  const reload = (): void => void renderList(root);
  const draw = (): void => {
    const shown = boosts.filter(matches);
    list.replaceChildren(
      ...(shown.length
        ? shown.map((b) => row(b, health[b.id], boosts.indexOf(b), boosts, reload))
        : [
            h("div", {
              className: "muted",
              textContent: boosts.length
                ? "Nothing matches."
                : "No boosts yet. Open a site and use the toolbar button, or create one here.",
            }),
          ]),
    );
  };
  draw();
  root.replaceChildren(
    h(
      "div",
      { className: "row spread" },
      h("h1", { textContent: "Boosts" }),
      h("span", { className: "muted", textContent: `${boosts.length} in all` }),
    ),
    actions(),
    toolbar(boosts, draw),
    list,
  );
}
