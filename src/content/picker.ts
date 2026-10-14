import { descriptor, safeQueryAll, selectorsFor, similarSelector } from "./target.js";

// The element picker: hover to highlight, arrows to move up and down the tree, click to choose.

export interface Picked {
  element: Element;
  selector: string;
  similar?: { selector: string; count: number };
  /** Shift was held: the person means every element like this one. */
  all: boolean;
}

const CSS_TEXT = `
:host { all: initial; }
.box { position: fixed; pointer-events: none; z-index: 2147483646; border: 2px solid #6d5dfc; background: rgba(109,93,252,.14); border-radius: 3px; transition: all .05s; }
.similar { position: fixed; pointer-events: none; z-index: 2147483645; border: 1px dashed #6d5dfc; background: rgba(109,93,252,.06); }
.tip { position: fixed; z-index: 2147483647; font: 12px/1.4 system-ui, sans-serif; background: #1b1b1f; color: #fff; padding: 6px 9px; border-radius: 7px; max-width: 520px; pointer-events: none; box-shadow: 0 4px 16px rgba(0,0,0,.25); }
.tip b { color: #b9b0ff; font-weight: 600; }
.bar { position: fixed; left: 50%; top: 12px; transform: translateX(-50%); z-index: 2147483647; font: 13px system-ui, sans-serif; background: #1b1b1f; color: #fff; padding: 8px 14px; border-radius: 999px; box-shadow: 0 4px 16px rgba(0,0,0,.25); }
`;

export function pickElement(prompt: string): Promise<Picked | undefined> {
  return new Promise((resolve) => {
    const host = document.createElement("site-boosts-picker");
    const root = host.attachShadow({ mode: "closed" });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS_TEXT);
    root.adoptedStyleSheets = [sheet];
    const box = document.createElement("div");
    box.className = "box";
    const tip = document.createElement("div");
    tip.className = "tip";
    const bar = document.createElement("div");
    bar.className = "bar";
    bar.textContent = `${prompt} · ↑↓ bigger or smaller · Esc to cancel`;
    root.append(box, tip, bar);
    document.documentElement.append(host);
    let current: Element | undefined;
    let ghosts: HTMLElement[] = [];

    const place = (el: HTMLElement, rect: DOMRect): void => {
      Object.assign(el.style, {
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      });
    };

    const show = (el: Element): void => {
      current = el;
      place(box, el.getBoundingClientRect());
      for (const ghost of ghosts) ghost.remove();
      const similar = similarSelector(el);
      ghosts = (similar ? safeQueryAll(similar.selector) : [])
        .filter((other) => other !== el)
        .slice(0, 60)
        .map((other) => {
          const ghost = document.createElement("div");
          ghost.className = "similar";
          place(ghost, other.getBoundingClientRect());
          root.append(ghost);
          return ghost;
        });
      const rect = el.getBoundingClientRect();
      tip.innerHTML = "";
      const name = document.createElement("b");
      name.textContent = descriptor(el);
      tip.append(name, similar ? ` · ${similar.count} like it` : "");
      tip.style.left = `${Math.min(Math.max(rect.left, 8), innerWidth - 300)}px`;
      tip.style.top = `${rect.top > 40 ? rect.top - 34 : Math.min(rect.bottom + 6, innerHeight - 36)}px`;
    };

    const finish = (result: Picked | undefined): void => {
      removeEventListener("mousemove", onMove, true);
      removeEventListener("click", onClick, true);
      removeEventListener("keydown", onKey, true);
      host.remove();
      resolve(result);
    };

    const onMove = (event: MouseEvent): void => {
      const el = document.elementFromPoint(event.clientX, event.clientY);
      if (el && el !== host && el !== current) show(el);
    };
    const onClick = (event: MouseEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      if (!current) return;
      finish({
        element: current,
        selector: selectorsFor(current)[0] ?? descriptor(current),
        similar: similarSelector(current),
        all: event.shiftKey,
      });
    };
    const onKey = (event: KeyboardEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") finish(undefined);
      else if (
        event.key === "ArrowUp" &&
        current?.parentElement &&
        current.parentElement !== document.documentElement
      )
        show(current.parentElement);
      else if (event.key === "ArrowDown" && current?.firstElementChild)
        show(current.firstElementChild);
      else if (event.key === "Enter" && current)
        finish({
          element: current,
          selector: selectorsFor(current)[0] ?? descriptor(current),
          similar: similarSelector(current),
          all: event.shiftKey,
        });
    };
    addEventListener("mousemove", onMove, true);
    addEventListener("click", onClick, true);
    addEventListener("keydown", onKey, true);
  });
}
