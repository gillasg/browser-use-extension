import {
  authorMessages,
  parseAuthorAnswer,
  SYSTEM_PROMPT,
  type PageContext,
} from "../shared/ai.js";
import { unifiedDiff, boostText } from "../shared/diff.js";
import { boostMatches, siteRuleFor } from "../shared/match.js";
import { errorText, sendToTab } from "../shared/messages.js";
import type { Boost, ChatTurn } from "../shared/types.js";
import { listSiteMappers } from "./integrations.js";
import { complete } from "./models.js";
import { runOnce, userScriptsAvailable } from "./scripts.js";
import { getBoost, getHealth, getSettings, log, putBoost, setHealth } from "./store.js";

// Writing and changing boosts with a model: ask, preview on the page, then keep or discard.
// Also repairs boosts that broke after a redesign.

interface Draft {
  boost: Boost;
  /** The saved boost this changes, if any. */
  baseId?: string;
  history: ChatTurn[];
  ranScript: boolean;
}

const drafts = new Map<number, Draft>();

export interface AuthorReply {
  reply: string;
  boost?: Boost;
  diff?: string;
}

/** Called after a boost is saved, so registrations and pages update. */
let afterSave: (boost: Boost) => Promise<void> = async () => undefined;
export function setAfterSave(callback: (boost: Boost) => Promise<void>): void {
  afterSave = callback;
}

async function preview(tabId: number, draft: Draft): Promise<void> {
  await sendToTab(tabId, "preview.show", { boost: draft.boost, replaces: draft.baseId });
  if (draft.boost.js && (await userScriptsAvailable())) {
    await runOnce({ ...draft.boost, id: `preview-${tabId}` }, tabId);
    draft.ranScript = true;
  }
}

/** What a request builds on: the unsaved draft in this tab, or the saved boost being changed. */
async function startingPoint(
  tabId: number,
  boostId?: string,
): Promise<{ current?: Boost; history: ChatTurn[]; baseId?: string; ranScript: boolean }> {
  const draft = drafts.get(tabId);
  if (draft && (!boostId || draft.baseId === boostId))
    return {
      current: draft.boost,
      history: draft.history,
      baseId: draft.baseId,
      ranScript: draft.ranScript,
    };
  const saved = boostId ? await getBoost(boostId) : undefined;
  return {
    current: saved,
    history: saved?.chat ?? [],
    baseId: saved?.id,
    ranScript: draft?.ranScript ?? false,
  };
}

export async function author(
  tabId: number,
  request: string,
  boostId?: string,
): Promise<AuthorReply> {
  const settings = await getSettings();
  const page = await sendToTab<PageContext>(tabId, "context.get");
  const start = await startingPoint(tabId, boostId);
  const current = start.current;
  const input = { request, page, current, history: start.history, apis: await listSiteMappers() };
  const answer = await complete(settings.model, SYSTEM_PROMPT, authorMessages(input));
  const result = parseAuthorAnswer(answer, input, siteRuleFor(page.url));
  if (!result.boost) return { reply: result.reply };
  const draft: Draft = {
    boost: result.boost,
    baseId: start.baseId,
    history: result.boost.chat ?? [],
    ranScript: start.ranScript,
  };
  drafts.set(tabId, draft);
  await preview(tabId, draft);
  return {
    reply: result.reply,
    boost: result.boost,
    diff: unifiedDiff(current ? boostText(current) : "", boostText(result.boost)),
  };
}

export function draftFor(tabId: number): Boost | undefined {
  return drafts.get(tabId)?.boost;
}

export async function keep(tabId: number): Promise<Boost> {
  const draft = drafts.get(tabId);
  if (!draft) throw new Error("Nothing to keep");
  drafts.delete(tabId);
  const boost = await putBoost(
    draft.boost,
    "ai",
    draft.history.filter((t) => t.role === "user").at(-1)?.text,
  );
  await sendToTab(tabId, "preview.clear").catch(() => undefined);
  await afterSave(boost);
  return boost;
}

export async function discard(tabId: number): Promise<void> {
  const draft = drafts.get(tabId);
  drafts.delete(tabId);
  // A script cannot be taken back out of a page: reload it instead.
  if (draft?.ranScript) await chrome.tabs.reload(tabId);
  else await sendToTab(tabId, "preview.clear").catch(() => undefined);
}

chrome.tabs.onRemoved.addListener((tabId) => drafts.delete(tabId));

// ---- Repair -------------------------------------------------------------------------

const REPAIR_COOLDOWN_MS = 30 * 60 * 1000;

async function tabFor(boost: Boost, tabId?: number): Promise<number | undefined> {
  if (tabId !== undefined) return tabId;
  const tabs = await chrome.tabs.query({});
  return tabs.find((tab) => tab.url && boostMatches(boost, tab.url))?.id;
}

/** Rewrites a broken boost against the page as it is now. Returns the repaired boost. */
export async function repair(
  boostId: string,
  tabId?: number,
  automatic = false,
): Promise<Boost | undefined> {
  const boost = await getBoost(boostId);
  const health = await getHealth(boostId);
  if (!boost) return undefined;
  if (automatic && health.repairedAt && Date.now() - health.repairedAt < REPAIR_COOLDOWN_MS)
    return undefined;
  const settings = await getSettings();
  const tab = await tabFor(boost, tabId);
  try {
    if (tab === undefined) throw new Error("Open the site to repair this boost");
    if (!health.last) throw new Error("Nothing is known yet about how it broke");
    const page = await sendToTab<PageContext>(tab, "context.get");
    const input = {
      request: "Repair this boost so it works on the page as it is now.",
      page,
      current: boost,
      history: [],
      repair: { last: health.last, lastGood: health.lastGood },
      apis: await listSiteMappers(),
    };
    const answer = await complete(settings.model, SYSTEM_PROMPT, authorMessages(input));
    const result = parseAuthorAnswer(answer, input, siteRuleFor(page.url));
    if (!result.boost) throw new Error(result.reply);
    const repaired = await putBoost({ ...result.boost, chat: boost.chat }, "repair", result.reply);
    await setHealth(boostId, {
      ...health,
      status: "unknown",
      misses: 0,
      broken: [],
      repairedAt: Date.now(),
      repairError: undefined,
    });
    await afterSave(repaired);
    await sendToTab(tab, "chip.notice", {
      text: `Repaired “${repaired.name}” after the site changed`,
      undo: repaired.id,
    }).catch(() => undefined);
    log({ level: "info", boostId, message: `Repaired: ${result.reply}` });
    return repaired;
  } catch (error) {
    await setHealth(boostId, { ...health, repairedAt: Date.now(), repairError: errorText(error) });
    log({ level: "warn", boostId, message: `Repair failed: ${errorText(error)}` });
    if (!automatic) throw error;
    return undefined;
  }
}

/** Automatic repair, when switched on and a model is connected. */
export async function autoRepair(boostId: string, tabId?: number): Promise<void> {
  const settings = await getSettings();
  const boost = await getBoost(boostId);
  if (
    !settings.autoRepair ||
    !settings.model ||
    !boost ||
    boost.autoRepair === false ||
    boost.kind !== "boost"
  )
    return;
  await repair(boostId, tabId, true);
}
