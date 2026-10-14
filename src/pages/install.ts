import type { DiffLine } from "../shared/diff.js";
import { errorText, send } from "../shared/messages.js";
import type { Review } from "../shared/review.js";
import type { Boost } from "../shared/types.js";
import { diffView, h, toast } from "./ui.js";

// Installing a userscript or userstyle from a link: what it is, what it can do, and the code,
// before anything is installed. Updates show what changed.

interface Prepared {
  boost: Boost;
  review: Review;
  existing?: { id: string; name: string; version?: string };
  diff?: string;
}

const app = document.getElementById("app") as HTMLElement;
const url = new URLSearchParams(location.search).get("url") ?? "";

const LEVEL: Record<Review["level"], string> = {
  low: "Low risk: it only changes how pages look or behave.",
  medium: "It runs code on the sites below.",
  high: "It runs code that can reach other sites with your logins. Install it only if you trust the author.",
};

/** Who wrote it and where it comes from. */
function byline(meta: Boost["meta"]): HTMLElement {
  const line = h("div", { className: "muted" });
  if (meta?.author) line.append(`By ${meta.author} · `);
  line.append(h("a", { href: url, textContent: new URL(url).hostname, target: "_blank" }));
  if (meta?.homepage)
    line.append(" · ", h("a", { href: meta.homepage, target: "_blank", textContent: "Homepage" }));
  return line;
}

function details(prepared: Prepared): HTMLElement {
  const { boost, review } = prepared;
  const meta = boost.meta;
  return h(
    "section",
    { className: "card stack" },
    h(
      "div",
      { className: "row spread" },
      h("h1", { textContent: boost.name }),
      meta?.version ? h("span", { className: "tag", textContent: `v${meta.version}` }) : "",
    ),
    meta?.description ? h("div", { textContent: meta.description }) : "",
    byline(meta),
    h("div", {
      className: review.level === "high" ? "warn" : "note",
      textContent: LEVEL[review.level],
    }),
    h("h3", { textContent: "Runs on" }),
    h("div", { textContent: review.sites.join(", ") }),
    review.lines.length ? h("h3", { textContent: "What it does" }) : "",
    ...review.lines.map((line) => h("div", { textContent: line })),
    ...review.warnings.map((line) => h("div", { className: "warn", textContent: line })),
  );
}

async function confirmInstall(prepared: Prepared): Promise<void> {
  const boost = await send<Boost>("install.confirm", { prepared });
  toast(prepared.existing ? "Updated" : "Installed");
  app.replaceChildren(
    h(
      "section",
      { className: "card stack" },
      h("h1", {
        textContent: prepared.existing ? `Updated “${boost.name}”` : `Installed “${boost.name}”`,
      }),
      h("div", {
        className: "muted",
        textContent: "It runs the next time you open or reload a matching page.",
      }),
      h(
        "div",
        { className: "row" },
        h("button", { className: "primary", textContent: "Close", onclick: () => window.close() }),
        h("a", { href: `manager.html#boost/${boost.id}`, textContent: "Open in the manager" }),
      ),
    ),
  );
}

/** Unified-diff text back into lines to colour. */
function changedLines(diff: string): DiffLine[] {
  return diff.split("\n").map((line) => ({
    kind: line[0] === "+" ? "+" : line[0] === "-" ? "-" : " ",
    text: line.slice(2),
  }));
}

function render(prepared: Prepared): void {
  const source = prepared.boost.source ?? "";
  const update = prepared.existing;
  const actions = h(
    "div",
    { className: "row" },
    h("button", {
      className: "primary",
      textContent: update ? `Update${update.version ? ` from v${update.version}` : ""}` : "Install",
      onclick: () => void confirmInstall(prepared).catch((e: unknown) => toast(errorText(e))),
    }),
    h("button", {
      textContent: "Cancel",
      onclick: () => (history.length > 1 ? history.back() : window.close()),
    }),
    h("button", {
      className: "link",
      textContent: "Show the raw file",
      onclick: () => void send("install.showSource", { url }).then(() => (location.href = url)),
    }),
  );
  app.replaceChildren(
    details(prepared),
    actions,
    h(
      "details",
      { open: Boolean(update) },
      h("summary", { textContent: update ? "What changed" : "The code" }),
      update && prepared.diff
        ? diffView(changedLines(prepared.diff))
        : h("pre", { className: "diff", textContent: source }),
    ),
  );
}

async function start(): Promise<void> {
  if (!url) {
    app.replaceChildren(
      h("div", { className: "error", textContent: "No script address was given." }),
    );
    return;
  }
  app.replaceChildren(h("div", { className: "muted", textContent: `Loading ${url}…` }));
  try {
    render(await send<Prepared>("install.prepare", { url }));
  } catch (error) {
    app.replaceChildren(
      h("div", { className: "error", textContent: errorText(error) }),
      h("a", {
        href: url,
        textContent: "Open the file instead",
        onclick: () => void send("install.showSource", { url }),
      }),
    );
  }
}

void start();
