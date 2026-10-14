import type { Boost, Look, PagePlan } from "../shared/types.js";
import { errorText, type Reply } from "../shared/messages.js";
import { Applier } from "./apply.js";
import { Chip, type ChipActions, type ChipState } from "./chip.js";
import { pageContext, setPicked } from "./context.js";
import { pickElement } from "./picker.js";
import { descriptor, sampleOf } from "./target.js";

// The content script: applies the boosts for this page, keeps them applied as the page and its URL
// change, reports their health, and runs the chip, the picker and previews.

const isTop = window === window.top;

async function send<T = unknown>(kind: string, data: Record<string, unknown> = {}): Promise<T> {
  const reply = (await chrome.runtime.sendMessage({ kind, ...data })) as Reply<T> | undefined;
  if (!reply?.ok) throw new Error(reply?.error ?? "The extension did not answer");
  return reply.value as T;
}

const applier = new Applier((kind, data) => send(kind, data));
let plan: PagePlan | undefined;
let preview: { boost: Boost; replaces?: string } | undefined;
let lookPreview: Look | undefined;
let chip: Chip | undefined;
let healthTimer: ReturnType<typeof setTimeout> | undefined;

const hasPagePart = (b: Boost): boolean =>
  Boolean(
    b.css || b.sections?.length || b.zaps?.length || b.look || b.actions?.length || b.html?.length,
  );

function apply(): void {
  if (!plan) return;
  const on =
    plan.siteDisabled || plan.paused
      ? []
      : plan.boosts.filter((b) => plan?.active.includes(b.id) && hasPagePart(b));
  let list = on;
  if (preview)
    list = [...on.filter((b) => b.id !== preview?.replaces), { ...preview.boost, id: "preview" }];
  if (lookPreview)
    list = [
      ...list,
      {
        id: "look-preview",
        name: "Look",
        kind: "boost",
        enabled: true,
        sites: [],
        order: 0,
        tags: [],
        created: 0,
        updated: Date.now(),
        look: lookPreview,
      },
    ];
  applier.set(list);
}

function scheduleHealth(): void {
  if (healthTimer) clearTimeout(healthTimer);
  healthTimer = setTimeout(() => void sendHealth(), 4000);
}

async function sendHealth(): Promise<void> {
  const reports = applier
    .reports()
    .filter((r) => r.boostId !== "preview" && r.boostId !== "look-preview");
  if (reports.length) await send("page.health", { reports }).catch(() => undefined);
}

async function refresh(): Promise<void> {
  try {
    plan = await send<PagePlan>("page.plan", { url: location.href, top: isTop });
  } catch {
    return;
  }
  apply();
  if (document.readyState === "complete") scheduleHealth();
  if (isTop) renderChip();
}

// ---- The chip -------------------------------------------------------------------------

function chipState(): ChipState {
  const p = plan as PagePlan;
  return {
    boosts: p.boosts,
    active: p.siteDisabled ? [] : p.active,
    health: p.health,
    siteOn: !p.siteDisabled,
    host: p.host,
    setupNeeded: p.setupNeeded,
  };
}

function renderChip(): void {
  if (!plan) return;
  if (!plan.showChip && !preview && !chip?.isOpen) {
    chip?.remove();
    return;
  }
  chip ??= new Chip(chipActions, chipState());
  chip.update(chipState());
}

async function guarded(work: () => Promise<void>, busy?: string): Promise<void> {
  chip?.update({ busy, error: undefined, open: true });
  try {
    await work();
  } catch (error) {
    chip?.update({ error: errorText(error) });
  } finally {
    chip?.update({ busy: undefined });
  }
}

async function zap(): Promise<void> {
  chip?.update({ open: false });
  const picked = await pickElement("Click what to hide · Shift-click to hide everything like it");
  if (!picked) return;
  const selector = picked.all && picked.similar ? picked.similar.selector : picked.selector;
  const boostId = await send<string>("zap.add", {
    url: location.href,
    zap: { selector, sample: sampleOf(picked.element) },
  });
  await refresh();
  chip?.update({
    notice: {
      text:
        picked.all && picked.similar ? `Hid ${picked.similar.count} elements like it` : "Hidden",
      undo: boostId,
    },
  });
}

const chipActions: ChipActions = {
  toggle: (id, on) => void send("site.boost", { host: plan?.host, id, on }).then(refresh),
  toggleSite: (on) => void send("site.toggle", { host: plan?.host, on }).then(refresh),
  ask: (text) =>
    guarded(async () => {
      const result = await send<{ reply: string; boost?: Boost }>("author.run", { request: text });
      if (result.boost) chip?.update({ preview: { name: result.boost.name, reply: result.reply } });
      else chip?.update({ notice: { text: result.reply }, open: true });
    }, "Writing…"),
  keep: () =>
    guarded(async () => {
      const boost = await send<Boost>("author.keep");
      preview = undefined;
      chip?.update({ preview: undefined, notice: { text: `Saved “${boost.name}”` } });
      await refresh();
    }),
  discard: () =>
    guarded(async () => {
      await send("author.discard");
      preview = undefined;
      chip?.update({ preview: undefined });
      apply();
    }),
  zap: () =>
    void zap().catch((error: unknown) => chip?.update({ error: errorText(error), open: true })),
  point: () =>
    void pickElement("Click the part you want to change").then((picked) => {
      if (!picked) return;
      setPicked(picked.element);
      chip?.update({
        open: true,
        error: undefined,
        notice: { text: `Pointing at ${descriptor(picked.element)}. Now describe the change.` },
      });
    }),
  undo: (id) =>
    void send("boost.undo", { id })
      .then(refresh)
      .then(() => chip?.update({ notice: undefined })),
  repair: (id) =>
    void guarded(async () => void (await send("repair.run", { id })), "Repairing…").then(refresh),
  manage: (id) => void send("open.manager", { id }),
};

// ---- Messages from the extension ------------------------------------------------------

type Handler = (message: Record<string, unknown>) => unknown;

const handlers: Record<string, Handler> = {
  "context.get": () => pageContext(),
  "plan.refresh": () => refresh(),
  "preview.show": (m) => {
    preview = { boost: m.boost as Boost, replaces: m.replaces as string | undefined };
    apply();
    chip?.update({
      preview: { name: preview.boost.name, reply: String(m.reply ?? "Previewing the change.") },
    });
  },
  "preview.clear": () => {
    preview = undefined;
    chip?.update({ preview: undefined });
    apply();
  },
  "look.preview": (m) => {
    lookPreview = (m.look as Look | undefined) ?? undefined;
    apply();
  },
  "chip.notice": (m) =>
    chip?.update({ notice: { text: String(m.text), undo: m.undo as string | undefined } }),
  "chip.open": () => {
    if (!plan) return;
    chip ??= new Chip(chipActions, chipState());
    chip.update({ ...chipState(), open: true });
  },
  "picker.zap": () => zap(),
  "picker.point": () => chipActions.point(),
  "health.now": () => sendHealth(),
  "applied.ids": () => applier.ids(),
};

chrome.runtime.onMessage.addListener(
  (message: Record<string, unknown>, _sender, reply: (r: Reply) => void) => {
    const handler = handlers[String(message.kind)];
    if (
      !handler ||
      (!isTop &&
        message.kind !== "plan.refresh" &&
        message.kind !== "preview.show" &&
        message.kind !== "preview.clear")
    )
      return false;
    Promise.resolve()
      .then(() => handler(message))
      .then(
        (value) => reply({ ok: true, value }),
        (error: unknown) => reply({ ok: false, error: errorText(error) }),
      );
    return true;
  },
);

// ---- Start, and follow URL changes in single-page apps ------------------------------------

let lastUrl = location.href;
setInterval(() => {
  if (location.href === lastUrl) return;
  lastUrl = location.href;
  void refresh();
}, 400);
addEventListener("load", scheduleHealth, { once: true });
void refresh();
