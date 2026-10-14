import { boostCss, cssSelectors } from "../shared/css.js";
import type { Boost, HealthReport, HtmlPart, Target } from "../shared/types.js";
import { ActionRunner } from "./actions.js";
import { findTargets, safeQueryAll, sampleOf } from "./target.js";

// Applies boosts to the page: styles, zaps (including text-matched ones), added HTML and actions,
// kept up to date as the page changes, with a health report of what matched.

type Send = (kind: string, data: Record<string, unknown>) => Promise<unknown>;

const ATTRIBUTE = "data-site-boosts";

function place(target: Element, nodes: Node[], position: HtmlPart["position"]): void {
  if (position === "before") target.before(...nodes);
  else if (position === "after") target.after(...nodes);
  else if (position === "prepend") target.prepend(...nodes);
  else if (position === "append") target.append(...nodes);
  else {
    (target as HTMLElement).style.setProperty("display", "none", "important");
    target.after(...nodes);
  }
}

/** Actions that find their element by text alone count as matching once they have run. */
function textActionCounts(boost: Boost, ran: number): HealthReport["selectors"] {
  return (boost.actions ?? [])
    .filter(
      (action) => !("selector" in action && action.selector) && "text" in action && action.text,
    )
    .map((action) => ({
      selector: `text "${(action as Target).text}"`,
      count: findTargets(action as Target).length + ran,
    }));
}

/** Every selector a boost depends on: its CSS, zaps, added HTML and actions. */
function boostSelectors(boost: Boost): string[] {
  const selectors = new Set(cssSelectors(boost.css ?? ""));
  for (const zap of boost.zaps ?? []) selectors.add(zap.selector);
  for (const part of boost.html ?? []) selectors.add(part.selector);
  for (const action of boost.actions ?? [])
    if ("selector" in action && action.selector) selectors.add(action.selector);
  return [...selectors];
}

class Applied {
  private style?: HTMLStyleElement;
  private insertedCss?: string;
  private runner?: ActionRunner;
  private hidden = new Set<HTMLElement>();
  private added = new Set<Element>();
  private errors: string[] = [];

  constructor(
    readonly boost: Boost,
    private send: Send,
  ) {}

  start(): void {
    const css = boostCss(this.boost, location.href);
    if (css) this.addStyle(css);
    if (this.boost.actions?.length) this.runner = new ActionRunner(this.boost.actions);
    this.update();
  }

  private addStyle(css: string): void {
    const style = document.createElement("style");
    style.setAttribute(ATTRIBUTE, this.boost.id);
    style.textContent = css;
    (document.head ?? document.documentElement).append(style);
    this.style = style;
    // A strict Content-Security-Policy blocks inline styles: the extension inserts it instead.
    if (!style.sheet) {
      this.insertedCss = css;
      void this.send("css.insert", { css }).catch(() => undefined);
    }
  }

  /** Re-runs what depends on the DOM: text zaps, HTML parts, actions. Keeps the style last. */
  update(): void {
    const head = document.head;
    if (head && this.style?.parentNode && this.style !== head.lastElementChild)
      head.append(this.style);
    for (const zap of this.boost.zaps ?? [])
      if (zap.contains) this.hideContaining(zap.selector, zap.contains.toLowerCase());
    for (const part of this.boost.html ?? []) this.insertHtml(part);
    this.runner?.scan();
  }

  private hideContaining(selector: string, wanted: string): void {
    for (const el of safeQueryAll(selector) as HTMLElement[]) {
      if (
        this.hidden.has(el) ||
        !(el.innerText ?? el.textContent ?? "").toLowerCase().includes(wanted)
      )
        continue;
      el.style.setProperty("display", "none", "important");
      this.hidden.add(el);
    }
  }

  private insertHtml(part: HtmlPart): void {
    for (const target of safeQueryAll(part.selector)) {
      if (target.hasAttribute(`${ATTRIBUTE}-html-${this.boost.id}`)) continue;
      target.setAttribute(`${ATTRIBUTE}-html-${this.boost.id}`, "");
      const template = document.createElement("template");
      template.innerHTML = part.html;
      const nodes = [...template.content.childNodes];
      for (const node of nodes) if (node instanceof Element) this.added.add(node);
      place(target, nodes, part.position);
    }
  }

  stop(): void {
    this.style?.remove();
    if (this.insertedCss)
      void this.send("css.remove", { css: this.insertedCss }).catch(() => undefined);
    for (const el of this.hidden) el.style.removeProperty("display");
    for (const el of this.added) el.remove();
    for (const el of safeQueryAll(`[${ATTRIBUTE}-html-${CSS.escape(this.boost.id)}]`)) {
      el.removeAttribute(`${ATTRIBUTE}-html-${this.boost.id}`);
      (el as HTMLElement).style.removeProperty("display");
    }
  }

  /** Which of the boost's selectors match, for health. */
  report(): HealthReport {
    const ran = this.runner?.ran ?? 0;
    const counts = boostSelectors(this.boost).map((selector) => {
      const found = safeQueryAll(selector);
      return { selector, count: found.length, sample: found[0] ? sampleOf(found[0]) : undefined };
    });
    return {
      url: location.href,
      source: "page",
      at: Date.now(),
      selectors: [...counts, ...textActionCounts(this.boost, ran)],
      actionsRun: ran,
      errors: [...this.errors, ...(this.runner?.errors ?? [])],
    };
  }
}

/** All boosts applied to this frame. */
export class Applier {
  private applied = new Map<string, Applied>();
  private observer?: MutationObserver;
  private scheduled = false;

  constructor(private send: Send) {}

  /** Makes the page match the given boosts: new ones start, removed ones stop, changed ones restart. */
  set(boosts: Boost[]): void {
    const wanted = new Map(boosts.map((b) => [b.id, b]));
    for (const [id, applied] of this.applied) {
      const next = wanted.get(id);
      if (
        !next ||
        next.updated !== applied.boost.updated ||
        JSON.stringify(next) !== JSON.stringify(applied.boost)
      ) {
        applied.stop();
        this.applied.delete(id);
      }
    }
    for (const boost of boosts) {
      if (this.applied.has(boost.id)) continue;
      const applied = new Applied(boost, this.send);
      this.applied.set(boost.id, applied);
      applied.start();
    }
    this.observe();
  }

  ids(): string[] {
    return [...this.applied.keys()];
  }

  private observe(): void {
    if (this.observer || !this.applied.size) return;
    this.observer = new MutationObserver(() => this.schedule());
    this.observer.observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener("DOMContentLoaded", () => this.schedule(), { once: true });
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    requestAnimationFrame(() => {
      this.scheduled = false;
      for (const applied of this.applied.values()) applied.update();
    });
    // Background tabs pause animation frames: make sure updates still happen.
    setTimeout(() => {
      if (!this.scheduled) return;
      this.scheduled = false;
      for (const applied of this.applied.values()) applied.update();
    }, 250);
  }

  reports(): { boostId: string; report: HealthReport }[] {
    return [...this.applied.values()].map((applied) => ({
      boostId: applied.boost.id,
      report: applied.report(),
    }));
  }

  clear(): void {
    for (const applied of this.applied.values()) applied.stop();
    this.applied.clear();
    this.observer?.disconnect();
    this.observer = undefined;
  }
}
