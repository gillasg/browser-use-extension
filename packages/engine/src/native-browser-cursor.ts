// The visible agent cursor and its caption, for the user watching the agent work. Purely
// cosmetic: every update is sent without awaiting, never fails or delays an action, ignores
// pointer input and stays out of the accessibility tree. Animation runs inside the page, so the
// agent moves on while the cursor is still gliding.
export interface CursorUpdate {
  x?: number;
  y?: number;
  /** Click: press the cursor down and ripple. */
  press?: boolean;
  /** I-beam over editable fields. */
  text?: boolean;
  /** Drag: draw a trail from here to x, y. */
  from?: { x: number; y: number };
  /** Caption pill shown beside the cursor. */
  caption?: string;
  /** Reveal the caption letter by letter (visible typing). */
  typing?: boolean;
  /** Skip if another caption appeared in the last moment (reads must not hide actions). */
  soft?: boolean;
}

const OVERLAY = `(update) => {
  const id = "aeon-agent-cursor";
  let host = document.getElementById(id);
  if (!host) {
    host = document.createElement("div");
    host.id = id;
    host.setAttribute("data-aeon-overlay", "");
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;contain:strict";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = '<style>' +
      '.c{position:absolute;left:0;top:0;will-change:transform}' +
      '.a,.t{position:absolute;left:-3px;top:-2px;filter:drop-shadow(0 2px 4px rgba(15,23,42,.35));transition:transform 120ms ease,opacity 120ms ease}' +
      '.t{left:-6px;top:-11px;opacity:0}.c.text .a{opacity:0}.c.text .t{opacity:1}' +
      '.c.down .a,.c.down .t{transform:scale(.82)}' +
      '.c.idle .a{animation:b 2.4s ease-in-out infinite}@keyframes b{50%{transform:scale(1.06);opacity:.85}}' +
      'i{position:absolute;left:-16px;top:-16px;width:32px;height:32px;border-radius:50%;border:2px solid rgba(99,102,241,.7);background:rgba(99,102,241,.18);transform:scale(0);opacity:0}' +
      'i.on{animation:r 520ms cubic-bezier(.2,.7,.2,1)}@keyframes r{0%{transform:scale(.25);opacity:1}100%{transform:scale(1.6);opacity:0}}' +
      '.p{position:absolute;left:18px;top:20px;max-width:320px;padding:5px 10px;border-radius:999px;background:rgba(17,24,39,.88);color:#fff;font:500 12px/16px system-ui,-apple-system,Segoe UI,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:0 4px 14px rgba(0,0,0,.25);opacity:0;transform:translateY(-3px);transition:opacity 160ms ease,transform 160ms ease}' +
      '.p.on{opacity:1;transform:none}' +
      'svg.trail{position:absolute;inset:0;width:100%;height:100%;overflow:visible}' +
      '</style><svg class="trail"></svg><div class="c"><i></i>' +
      '<svg class="a" width="22" height="24" viewBox="0 0 22 24"><path d="M2 2l7.5 19 2.6-7.6L20 10.8z" fill="#4f46e5" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>' +
      '<svg class="t" width="12" height="22" viewBox="0 0 12 22"><path d="M2 1.5h8M2 20.5h8M6 1.5v19" stroke="#4f46e5" stroke-width="2.2" stroke-linecap="round" fill="none"/></svg>' +
      '<div class="p"></div></div>';
    const state = host.__s = {
      root, cursor: root.querySelector(".c"), ripple: root.querySelector("i"),
      pill: root.querySelector(".p"), trail: root.querySelector("svg.trail"),
      pageX: innerWidth / 2 + scrollX, pageY: innerHeight / 2 + scrollY, frame: 0, idle: 0, hide: 0, type: 0,
    };
    // Pinned to the page, not the viewport: when the page scrolls, the cursor scrolls with it.
    const place = () => { state.cursor.style.transform = "translate(" + (state.pageX - scrollX) + "px," + (state.pageY - scrollY) + "px)"; };
    state.place = place;
    addEventListener("scroll", place, { passive: true, capture: true });
    (document.documentElement || document.body).append(host);
    place();
  }
  const s = host.__s;
  s.cursor.classList.remove("idle");
  clearTimeout(s.idle);
  s.idle = setTimeout(() => s.cursor.classList.add("idle"), 2200);
  if (update.text !== undefined) s.cursor.classList.toggle("text", update.text);
  if (typeof update.x === "number" && typeof update.y === "number") {
    // Glide along a gentle curve with ease-out, sized to the distance travelled.
    const fromX = s.pageX, fromY = s.pageY, toX = update.x + scrollX, toY = update.y + scrollY;
    const dx = toX - fromX, dy = toY - fromY, distance = Math.hypot(dx, dy);
    const duration = Math.min(520, 140 + distance * 0.45), bend = Math.min(80, distance * 0.18);
    const cx = fromX + dx / 2 - (dy / (distance || 1)) * bend, cy = fromY + dy / 2 + (dx / (distance || 1)) * bend;
    const start = performance.now();
    cancelAnimationFrame(s.frame);
    const step = (now) => {
      const t = Math.min(1, (now - start) / duration), e = 1 - Math.pow(1 - t, 3);
      s.pageX = (1 - e) * (1 - e) * fromX + 2 * (1 - e) * e * cx + e * e * toX;
      s.pageY = (1 - e) * (1 - e) * fromY + 2 * (1 - e) * e * cy + e * e * toY;
      s.place();
      if (t < 1) s.frame = requestAnimationFrame(step);
      else if (update.press) press();
    };
    s.frame = requestAnimationFrame(step);
    if (update.from) trail(update.from.x, update.from.y, update.x, update.y);
  } else if (update.press) press();
  function press() {
    s.cursor.classList.add("down");
    setTimeout(() => s.cursor.classList.remove("down"), 140);
    s.ripple.classList.remove("on"); void s.ripple.offsetWidth; s.ripple.classList.add("on");
  }
  function trail(x1, y1, x2, y2) {
    s.trail.innerHTML = '<path d="M' + x1 + ' ' + y1 + ' L' + x2 + ' ' + y2 + '" stroke="rgba(99,102,241,.55)" stroke-width="3" stroke-linecap="round" stroke-dasharray="6 6" fill="none"/>';
    setTimeout(() => { s.trail.innerHTML = ""; }, 900);
  }
  if (update.caption && !(update.soft && Date.now() - (s.captionAt || 0) < 1500)) {
    s.captionAt = Date.now();
    const text = String(update.caption).slice(0, 120);
    clearTimeout(s.hide); clearInterval(s.type);
    s.pill.classList.add("on");
    if (update.typing) {
      // Visual only: the real text is already in the field; the caption just reveals it.
      let shown = 0; const prefix = text.indexOf('"') + 1;
      s.pill.textContent = text.slice(0, prefix);
      s.type = setInterval(() => {
        shown += Math.max(1, Math.ceil((text.length - prefix) / 12));
        s.pill.textContent = text.slice(0, prefix + shown);
        if (prefix + shown >= text.length) clearInterval(s.type);
      }, 22);
    } else s.pill.textContent = text;
    s.hide = setTimeout(() => s.pill.classList.remove("on"), 3200);
  }
}`;

export function showAgentCursor(
  debuggee: chrome.debugger.Debuggee,
  x: number,
  y: number,
  press = false,
  extra: Omit<CursorUpdate, "x" | "y" | "press"> = {},
): void {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  updateAgentCursor(debuggee, { ...extra, x: Math.round(x), y: Math.round(y), press });
}

/** A caption without moving the cursor, e.g. while reading or navigating. */
export function showAgentCaption(debuggee: chrome.debugger.Debuggee, caption: string): void {
  updateAgentCursor(debuggee, { caption, soft: true });
}

function updateAgentCursor(debuggee: chrome.debugger.Debuggee, update: CursorUpdate): void {
  void chrome.debugger
    .sendCommand(debuggee, "Runtime.evaluate", {
      expression: `(${OVERLAY})(${JSON.stringify(update)})`,
      silent: true,
    })
    .catch(() => undefined);
}
