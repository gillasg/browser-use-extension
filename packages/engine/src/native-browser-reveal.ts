import { onNode } from "./native-browser-dom.js";
import { BrowserActionError } from "./native-browser-common.js";

// A hidden target is often a collapsed control: narrow layouts (Split View, small windows) fold a
// search box or menu behind a toggle. Name the visible control that most likely reveals it, so the
// agent clicks that first instead of guessing other selectors.
export async function hiddenTargetError(
  debuggee: chrome.debugger.Debuggee,
  id: number,
): Promise<Error> {
  const hint = await onNode<string>(debuggee, id, revealHint).catch(() => "");
  return hint ? new BrowserActionError("TARGET_HIDDEN", hint) : new Error("TARGET_HIDDEN");
}

// Runs in the page with `this` = the hidden element; must stay self-contained.
function revealHint(this: HTMLElement): string {
  const words = (text: string | null | undefined) =>
    (text ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2);
  const labelOf = (el: Element) =>
    (
      el.getAttribute("aria-label") ||
      el.getAttribute("title") ||
      el.getAttribute("placeholder") ||
      el.textContent ||
      ""
    )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60);
  const purpose = new Set([
    ...words(this.getAttribute("name")),
    ...words(this.getAttribute("placeholder")),
    ...words(this.getAttribute("aria-label")),
    ...words(this.getAttribute("type")),
    ...words(this.id),
  ]);
  const visible = (el: Element) => {
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return box.width > 0 && box.height > 0 && style.visibility !== "hidden";
  };
  const selectorOf = (el: Element) => {
    if (el.id) return "#" + CSS.escape(el.id);
    const classes = [...el.classList].slice(0, 2).map((name) => "." + CSS.escape(name));
    return el.tagName.toLowerCase() + classes.join("");
  };
  const toggles = "button,[role=button],a,summary,[aria-expanded],[aria-controls]";
  let scope: Element | null = this.parentElement;
  for (let depth = 0; scope && depth < 8; depth++, scope = scope.parentElement) {
    const candidates = [...scope.querySelectorAll(toggles)].filter(
      (el) => el !== this && !el.contains(this) && visible(el),
    );
    const match =
      candidates.find((el) => el.getAttribute("aria-expanded") === "false") ??
      candidates.find((el) =>
        words(labelOf(el) + " " + el.className).some((word) => purpose.has(word)),
      );
    if (match)
      return `this field is collapsed (narrow layout); click the visible "${labelOf(match) || "toggle"}" control (${selectorOf(match)}) to reveal it, then retry`;
  }
  return "";
}
