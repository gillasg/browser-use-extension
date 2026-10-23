import type { Action, Target } from "../shared/types.js";
import { findTargets, safeQueryAll } from "./target.js";

// Behaviour boosts: actions on every visit, on elements present now and ones that appear later.

function setValue(el: Element, value: string): void {
  const input = el as HTMLInputElement;
  input.focus();
  // Use the native setter so frameworks that track the value notice the change.
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function selectOption(el: Element, value: string): void {
  if (!(el instanceof HTMLSelectElement)) return setValue(el, value);
  const option = [...el.options].find(
    (o) => o.value === value || o.text.trim().toLowerCase() === value.toLowerCase(),
  );
  setValue(el, option?.value ?? value);
}

function press(el: Element, key: string): void {
  const target = el as HTMLElement;
  target.focus();
  for (const type of ["keydown", "keypress", "keyup"])
    target.dispatchEvent(
      new KeyboardEvent(type, {
        key,
        code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
        bubbles: true,
      }),
    );
  if (key === "Enter" && target instanceof HTMLInputElement) target.form?.requestSubmit();
}

function sortItems(action: Extract<Action, { do: "sort" }>): number {
  const items = safeQueryAll(action.items);
  const groups = new Map<Element, Element[]>();
  for (const item of items) {
    const parent = item.parentElement;
    if (!parent) continue;
    groups.set(parent, [...(groups.get(parent) ?? []), item]);
  }
  const keyOf = (item: Element): string | number => {
    const text = (item.querySelector(action.key)?.textContent ?? "").trim();
    if (!action.numeric) return text.toLowerCase();
    const number = Number(
      text
        .replace(/[^\d.,-]/g, "")
        .replace(/,(?=\d{3}\b)/g, "")
        .replace(",", "."),
    );
    return Number.isFinite(number) ? number : Number.POSITIVE_INFINITY;
  };
  const sign = action.order === "desc" ? -1 : 1;
  let moved = 0;
  for (const [parent, group] of groups) {
    const sorted = [...group].sort((a, b) => {
      const x = keyOf(a);
      const y = keyOf(b);
      return (x < y ? -1 : x > y ? 1 : 0) * sign;
    });
    if (sorted.every((item, i) => item === group[i])) continue;
    for (const item of sorted) parent.append(item);
    moved += sorted.length;
  }
  return moved;
}

function pauseMedia(): number {
  let paused = 0;
  for (const media of document.querySelectorAll<HTMLMediaElement>("video, audio")) {
    if (media.dataset.siteBoostsPlay === "1") continue;
    media.autoplay = false;
    if (!media.paused) {
      media.pause();
      paused++;
    }
    if (media.dataset.siteBoostsPaused) continue;
    media.dataset.siteBoostsPaused = "1";
    // A play the person starts (by clicking) is allowed from then on.
    media.addEventListener("play", () => {
      if (navigator.userActivation?.isActive) media.dataset.siteBoostsPlay = "1";
      else if (media.dataset.siteBoostsPlay !== "1") media.pause();
    });
  }
  return paused;
}

/** Acts on one element. Returns whether it did something. */
function actOn(action: Action, el: Element): boolean {
  switch (action.do) {
    case "click":
      (el as HTMLElement).click();
      return true;
    case "remove":
      el.remove();
      return true;
    case "fill":
      setValue(el, action.value);
      return true;
    case "select":
      selectOption(el, action.value);
      return true;
    case "check":
      if ((el as HTMLInputElement).checked !== (action.value ?? true)) (el as HTMLElement).click();
      return true;
    case "press":
      press(el, action.key);
      return true;
    case "scroll":
      el.scrollIntoView({ block: "center" });
      return true;
    default:
      return false;
  }
}

/** Runs a boost's actions as the page changes. */
export class ActionRunner {
  private done = new WeakMap<Action, WeakSet<Element>>();
  private counts = new Map<Action, number>();
  private loaded = new Set<Action>();
  ran = 0;
  errors: string[] = [];

  constructor(private actions: Action[]) {}

  /** Call on start and after DOM changes. */
  scan(): void {
    for (const action of this.actions) {
      try {
        this.runAction(action);
      } catch (error) {
        if (this.errors.length < 5)
          this.errors.push(
            `${action.do}: ${error instanceof Error ? error.message : String(error)}`,
          );
      }
    }
  }

  private budget(action: Action): boolean {
    return action.times === undefined || (this.counts.get(action) ?? 0) < action.times;
  }

  private count(action: Action): void {
    this.counts.set(action, (this.counts.get(action) ?? 0) + 1);
    this.ran++;
  }

  /** Actions on the whole page rather than on matching elements. Returns whether it was one. */
  private pageAction(action: Action): boolean {
    if (action.do === "wait") return true;
    if (action.do === "sort") {
      if (sortItems(action)) this.count(action);
      return true;
    }
    if (action.do === "pauseMedia") {
      if (pauseMedia()) this.count(action);
      return true;
    }
    if (action.do !== "scroll" || !action.to || action.to === "element") return false;
    if (!this.loaded.has(action)) {
      this.loaded.add(action);
      scrollTo({ top: action.to === "top" ? 0 : document.documentElement.scrollHeight });
      this.count(action);
    }
    return true;
  }

  private runAction(action: Action): void {
    if (!this.budget(action) || this.pageAction(action)) return;
    if (action.when === "load" && this.loaded.has(action)) return;
    const seen = this.done.get(action) ?? new WeakSet<Element>();
    this.done.set(action, seen);
    for (const el of findTargets(action as Target)) {
      if (seen.has(el) || !this.budget(action)) continue;
      seen.add(el);
      if (actOn(action, el)) this.count(action);
      if (action.when === "load") {
        this.loaded.add(action);
        break;
      }
    }
  }
}
