import { describeHealth } from "../shared/health.js";
import type { Boost, Health } from "../shared/types.js";

// The Tweaks chip: a small button on pages with boosts. It lists them with switches, previews new
// ones, and takes plain-English requests.

export interface ChipActions {
  toggle(id: string, on: boolean): void;
  toggleSite(on: boolean): void;
  ask(text: string): Promise<void>;
  keep(): Promise<void>;
  discard(): Promise<void>;
  zap(): void;
  point(): void;
  undo(id: string): void;
  repair(id: string): void;
  manage(id?: string): void;
}

export interface ChipState {
  boosts: Boost[];
  active: string[];
  health: Record<string, Health>;
  siteOn: boolean;
  host: string;
  setupNeeded: boolean;
  preview?: { name: string; reply: string };
  notice?: { text: string; undo?: string };
  busy?: string;
  error?: string;
  open?: boolean;
}

const CSS_TEXT = `
:host { all: initial; }
* { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
.wrap { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; color: #1b1b1f; font-size: 13px; }
.pill { all: unset; cursor: pointer; display: flex; align-items: center; gap: 6px; background: #1b1b1f; color: #fff; border-radius: 999px; padding: 7px 12px; box-shadow: 0 4px 14px rgba(0,0,0,.22); font-size: 13px; }
.pill:hover { background: #2c2c33; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: #f5a524; }
.panel { width: 320px; max-height: 70vh; overflow: auto; background: #fff; border: 1px solid #e3e3ea; border-radius: 14px; box-shadow: 0 10px 34px rgba(0,0,0,.18); padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.head { display: flex; justify-content: space-between; align-items: center; font-weight: 600; }
.muted { color: #6b6b76; font-weight: 400; font-size: 12px; }
.row { display: flex; align-items: center; gap: 8px; justify-content: space-between; }
.name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.broken { color: #b54708; font-size: 12px; }
.switch { all: unset; cursor: pointer; width: 30px; height: 18px; border-radius: 999px; background: #cfcfd8; position: relative; flex: none; }
.switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: #fff; transition: left .12s; }
.switch[aria-checked="true"] { background: #6d5dfc; }
.switch[aria-checked="true"]::after { left: 14px; }
textarea { width: 100%; resize: vertical; min-height: 54px; border: 1px solid #d9d9e0; border-radius: 9px; padding: 8px; font-size: 13px; color: inherit; background: inherit; }
.buttons { display: flex; gap: 6px; flex-wrap: wrap; }
button.b { all: unset; cursor: pointer; padding: 6px 10px; border-radius: 8px; background: #f0f0f4; font-size: 12.5px; }
button.b:hover { background: #e4e4ea; }
button.b.primary { background: #6d5dfc; color: #fff; }
button.b.primary:hover { background: #5a4ae8; }
button.link { all: unset; cursor: pointer; color: #5a4ae8; font-size: 12px; }
.note { background: #f4f2ff; border-radius: 9px; padding: 8px 10px; }
.error { background: #fff1ee; color: #a3260f; border-radius: 9px; padding: 8px 10px; }
@media (prefers-color-scheme: dark) {
  .wrap { color: #ececf1; }
  .panel { background: #1f1f24; border-color: #34343d; }
  textarea { border-color: #3a3a44; }
  button.b { background: #2c2c33; color: #ececf1; } button.b:hover { background: #383840; }
  .note { background: #2a2740; } .error { background: #3b1f1a; color: #ffb4a6; }
  .muted { color: #a0a0ab; } .switch { background: #4a4a55; }
}
`;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

function button(label: string, onClick: () => void, className = "b"): HTMLButtonElement {
  return el("button", { className, textContent: label, onclick: onClick });
}

function toggle(on: boolean, label: string, onChange: (on: boolean) => void): HTMLButtonElement {
  const control = el("button", { className: "switch", title: label });
  control.setAttribute("role", "switch");
  control.setAttribute("aria-checked", String(on));
  control.setAttribute("aria-label", label);
  control.onclick = () => onChange(control.getAttribute("aria-checked") !== "true");
  return control;
}

export class Chip {
  private host = document.createElement("site-boosts-chip");
  private root = this.host.attachShadow({ mode: "open" });
  private state: ChipState;
  private draft = "";
  private wasExpanded = false;

  constructor(
    private actions: ChipActions,
    initial: ChipState,
  ) {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS_TEXT);
    this.root.adoptedStyleSheets = [sheet];
    this.state = initial;
  }

  update(patch: Partial<ChipState>): void {
    this.state = { ...this.state, ...patch };
    this.render();
  }

  get isOpen(): boolean {
    return Boolean(this.state.open);
  }

  remove(): void {
    this.host.remove();
  }

  private mount(): void {
    if (!this.host.isConnected) document.documentElement.append(this.host);
  }

  private render(): void {
    const s = this.state;
    const expanded = Boolean(s.open || s.preview || s.busy || s.error);
    if (!expanded && !s.notice && !s.boosts.length) return this.remove();
    this.mount();
    const wrap = el("div", { className: "wrap" });
    if (expanded) wrap.append(this.panel());
    else if (s.notice) wrap.append(this.noticeBox());
    wrap.append(this.pill());
    this.root.replaceChildren(wrap);
    // Focus the request box when the panel opens, not on every update.
    if (expanded && !this.wasExpanded) this.root.querySelector("textarea")?.focus();
    this.wasExpanded = expanded;
  }

  private pill(): HTMLButtonElement {
    const s = this.state;
    const count = s.boosts.filter((b) => s.active.includes(b.id)).length;
    const broken = s.boosts.some((b) => s.health[b.id]?.status === "broken");
    const pill = button("", () => this.update({ open: !s.open, notice: undefined }), "pill");
    pill.setAttribute("aria-label", "Site Boosts");
    pill.append("⚡", count ? ` ${count}` : "");
    if (broken) pill.append(el("span", { className: "dot", title: "A boost stopped working" }));
    return pill;
  }

  private noticeBox(): HTMLElement {
    const notice = this.state.notice;
    const box = el(
      "div",
      { className: "panel" },
      el("div", { className: "note", textContent: notice?.text ?? "" }),
    );
    const undo = notice?.undo;
    if (undo)
      box.append(
        el(
          "div",
          { className: "buttons" },
          button("Undo", () => this.actions.undo(undo)),
          button("OK", () => this.update({ notice: undefined })),
        ),
      );
    return box;
  }

  private panel(): HTMLElement {
    const s = this.state;
    const panel = el("div", { className: "panel" });
    const head = el(
      "div",
      { className: "head" },
      el("span", {}, "Site Boosts ", el("span", { className: "muted", textContent: s.host })),
    );
    head.append(toggle(s.siteOn, `Boosts on ${s.host}`, (on) => this.actions.toggleSite(on)));
    panel.append(head);
    if (s.setupNeeded)
      panel.append(
        el(
          "div",
          { className: "note" },
          "Boosts with JavaScript need one setting. ",
          button("Set up", () => this.actions.manage("setup"), "link"),
        ),
      );
    if (s.error) panel.append(el("div", { className: "error", textContent: s.error }));
    if (s.notice && !s.preview)
      panel.append(el("div", { className: "note", textContent: s.notice.text }));
    if (s.preview) panel.append(this.previewBox(s.preview));
    else panel.append(...this.list());
    panel.append(this.askBox());
    return panel;
  }

  private previewBox(preview: NonNullable<ChipState["preview"]>): HTMLElement {
    const box = el(
      "div",
      { className: "note" },
      el("div", { textContent: preview.reply }),
      el("div", { className: "muted", textContent: `Previewing “${preview.name}”` }),
    );
    box.append(
      el(
        "div",
        { className: "buttons" },
        button("Keep", () => void this.actions.keep(), "b primary"),
        button("Discard", () => void this.actions.discard()),
      ),
    );
    return box;
  }

  private list(): HTMLElement[] {
    const s = this.state;
    if (!s.boosts.length)
      return [el("div", { className: "muted", textContent: "No boosts on this site yet." })];
    return s.boosts.map((boost) => {
      const health = s.health[boost.id];
      const name = el("div", {
        className: "name",
        title: boost.description ?? boost.name,
        textContent: boost.name,
      });
      const row = el("div", { className: "row" }, name);
      if (health?.status === "broken") {
        name.append(el("div", { className: "broken", textContent: describeHealth(health) }));
        row.append(button("Repair", () => this.actions.repair(boost.id), "link"));
      }
      row.append(button("Edit", () => this.actions.manage(boost.id), "link"));
      row.append(
        toggle(s.active.includes(boost.id), `${boost.name} on this site`, (on) =>
          this.actions.toggle(boost.id, on),
        ),
      );
      return row;
    });
  }

  private askBox(): HTMLElement {
    const s = this.state;
    const box = el("div", { className: "row" });
    box.style.cssText = "flex-direction: column; align-items: stretch;";
    const input = el("textarea", {
      placeholder: s.preview ? "Change it…" : "Describe a change, like “hide the sidebar”",
      value: this.draft,
    });
    input.oninput = () => (this.draft = input.value);
    input.onkeydown = (event) => {
      event.stopPropagation();
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        send();
      }
    };
    const send = (): void => {
      const text = this.draft.trim();
      if (!text || s.busy) return;
      this.draft = "";
      void this.actions.ask(text);
    };
    const buttons = el(
      "div",
      { className: "buttons" },
      button(s.busy ?? (s.preview ? "Change" : "Boost it"), send, "b primary"),
      button("Point at it", () => this.actions.point()),
      button("Zap", () => this.actions.zap()),
      button("Manage", () => this.actions.manage()),
    );
    box.append(input, buttons);
    return box;
  }
}
