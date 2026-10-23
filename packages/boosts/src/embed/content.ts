import type { Boost, PagePlan } from "../shared/types.js";
import { errorText, type Reply } from "../shared/messages.js";
import { Applier } from "../content/apply.js";

// The content script of the embedded engine: applies the boosts for this page and keeps them
// applied as the page and its URL change. No toolbar, picker or previews: those are Site Boosts'.

const PREFIX = "boosts.";
const isTop = window === window.top;

async function send<T = unknown>(kind: string, data: Record<string, unknown> = {}): Promise<T> {
  const reply = (await chrome.runtime.sendMessage({ kind: PREFIX + kind, ...data })) as
    Reply<T> | undefined;
  if (!reply?.ok) throw new Error(reply?.error ?? "The extension did not answer");
  return reply.value as T;
}

const applier = new Applier((kind, data) => send(kind, data));
let healthTimer: ReturnType<typeof setTimeout> | undefined;

const hasPagePart = (b: Boost): boolean =>
  Boolean(
    b.css || b.sections?.length || b.zaps?.length || b.look || b.actions?.length || b.html?.length,
  );

async function refresh(): Promise<void> {
  let plan: PagePlan;
  try {
    plan = await send<PagePlan>("page.plan", { url: location.href, top: isTop });
  } catch {
    return;
  }
  applier.set(
    plan.siteDisabled || plan.paused
      ? []
      : plan.boosts.filter((b) => plan.active.includes(b.id) && hasPagePart(b)),
  );
  if (document.readyState === "complete") scheduleHealth();
}

function scheduleHealth(): void {
  if (healthTimer) clearTimeout(healthTimer);
  healthTimer = setTimeout(() => {
    const reports = applier.reports();
    if (reports.length) void send("page.health", { reports }).catch(() => undefined);
  }, 4000);
}

chrome.runtime.onMessage.addListener(
  (message: Record<string, unknown>, _sender, reply: (r: Reply) => void) => {
    if (message?.kind !== `${PREFIX}plan.refresh`) return false;
    refresh().then(
      () => reply({ ok: true }),
      (error: unknown) => reply({ ok: false, error: errorText(error) }),
    );
    return true;
  },
);

let lastUrl = location.href;
setInterval(() => {
  if (location.href === lastUrl) return;
  lastUrl = location.href;
  void refresh();
}, 400);
addEventListener("load", scheduleHealth, { once: true });
void refresh();
