// A visible agent cursor for the user watching in Split View. Purely cosmetic: it is sent
// without awaiting, never fails an action, ignores pointer input and stays out of the AX tree.
const CURSOR = (x: number, y: number, press: boolean) => `(() => {
  const id = "aeon-agent-cursor";
  let host = document.getElementById(id);
  if (!host) {
    host = document.createElement("div");
    host.id = id;
    host.setAttribute("data-aeon-overlay", "");
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;transition:transform 160ms cubic-bezier(.2,.7,.2,1);";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = '<style>svg{position:absolute;left:-3px;top:-2px;filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))}i{position:absolute;left:-14px;top:-14px;width:28px;height:28px;border-radius:50%;background:rgba(99,102,241,.35);transform:scale(0);opacity:0}i.on{animation:p 420ms ease-out}@keyframes p{0%{transform:scale(.2);opacity:1}100%{transform:scale(1.4);opacity:0}}</style><i></i><svg width="22" height="24" viewBox="0 0 22 24"><path d="M2 2l7.5 19 2.6-7.6L20 10.8z" fill="#4f46e5" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    host.__pulse = root.querySelector("i");
    (document.documentElement || document.body).append(host);
  }
  host.style.transform = "translate(${x}px, ${y}px)";
  if (${press}) {
    const pulse = host.__pulse;
    pulse.classList.remove("on");
    void pulse.offsetWidth;
    pulse.classList.add("on");
  }
})()`;

export function showAgentCursor(
  debuggee: chrome.debugger.Debuggee,
  x: number,
  y: number,
  press = false,
): void {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  void chrome.debugger
    .sendCommand(debuggee, "Runtime.evaluate", {
      expression: CURSOR(Math.round(x), Math.round(y), press),
      silent: true,
    })
    .catch(() => undefined);
}
