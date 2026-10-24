import { performFlow, requireModel, type ModelLike } from "./agent.js";
import { siteName } from "./registry.js";
import type { Bridge } from "./runtime/bridge.js";
import { rebuild } from "./workflow.js";

// Mapping a site by name: an agent opens it in the user's browser and uses its main features
// (search, filters, pages, item details, sections) while every request is recorded, then the API
// is built from that. Several sites run at once, each in its own background tab.

export const EXPLORE_BRIEF = `Use this site's main features so that its API shows up in the recording:
- search for something typical for this site, and open the next page of results;
- apply a filter or change the sort order;
- open an item's or an article's details page;
- open the main sections or categories from its navigation.
Look around, do not change anything: never buy, book, post, send, follow, like, delete or change settings. Close pop-ups and cookie banners. Stop once these have been done.`;

/** With actions: true, writes are blocked in the browser, so the agent may press action buttons. */
export const EXPLORE_ACTIONS_BRIEF = `Use this site's main features so that its API shows up in the recording: search, open the next page of results, apply a filter, open an item's details, open the main sections.
This tab is in dry run: any request that would change something is blocked before it reaches the site and only recorded. So also use each of the site's main actions once (for example like, follow, save, add to cart, comment, send a message, post), filling forms with harmless test values. The page may act as if it worked; nothing was sent. Do not enter payment card details or passwords. Close pop-ups and cookie banners. Stop once these have been done.`;

export interface ExploreOptions {
  /** Extra things to do, for example "check delivery dates" or "open the cart". */
  goal?: string;
  model?: ModelLike;
  bridge?: () => Promise<Bridge>;
  /** Browser steps per site (default 25). */
  maxSteps?: number;
  /** Sites at once (default 1 in quiet mode, 3 otherwise; never more than 3). */
  parallel?: number;
  /** Same as parallel; a clearer name for callers that think in workers. */
  concurrency?: number;
  /** Bring tabs to the front (default false: background tabs). */
  foreground?: boolean;
  /** Block popunders, autoplay and ad hosts (default true). */
  quiet?: boolean;
  onSite?: (result: ExploreResult) => void;
  /** Also map the site's actions (like, send, post, add to cart) in dry run: blocked, recorded only. */
  actions?: boolean;
}

export interface ExploreResult {
  site: string;
  summary?: string;
  operations?: number;
  version?: number;
  /** What stopped a failed site: timeout, challenged, signed-out, no-api-found, tab-crashed… */
  kind?: string;
  /** Tabs this explore opened; leftOpen is non-empty only if closing them failed. */
  tabs?: number[];
  leftOpen?: number[];
  error?: string;
}

const brief = (options: ExploreOptions) =>
  options.actions ? EXPLORE_ACTIONS_BRIEF : EXPLORE_BRIEF;

async function exploreOne(
  site: string,
  model: ModelLike,
  options: ExploreOptions & { quiet: boolean },
): Promise<ExploreResult> {
  const name = siteName(site);
  // A full URL starts there; a bare name starts at its home page.
  const startUrl = /^https?:\/\//i.test(site) ? site : undefined;
  try {
    const flow = await performFlow(
      name,
      options.goal ? `${brief(options)}\nAlso: ${options.goal}` : brief(options),
      {
        model,
        maxSteps: options.maxSteps ?? 25,
        session: `site-to-api-explore-${name}`,
        ...(startUrl ? { startUrl } : {}),
        foreground: options.foreground === true,
        quiet: options.quiet,
        ...(options.actions ? { dryRun: true } : {}),
        ...(options.bridge ? { bridge: options.bridge } : {}),
      },
    );
    const built = await rebuild(name);
    if (!built.model.operations.length)
      return {
        site: name,
        summary: flow.summary,
        kind: "no-api-found",
        operations: 0,
        version: built.version,
        error: "the site worked, but no API call was learned from the recording",
      };
    return {
      site: name,
      summary: flow.summary,
      operations: built.model.operations.length,
      version: built.version,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      site: name,
      error: message,
      kind: failureKind(message),
      tabs: tabsOf(error),
      leftOpen: leftOpenOf(error),
    };
  }
}

/** Maps the browser or map failure to the kind a caller can act on. */
export function failureKind(message: string): string {
  const text = message.toLowerCase();
  if (/timeout|timed out|deadline/.test(text)) return "timeout";
  if (/cloudflare|datadome|perimeterx|akamai|challenge|captcha|bot check/.test(text))
    return "challenged";
  if (/signed out|sign in|login|401|403/.test(text)) return "signed-out";
  if (/crash|aw, snap|target closed|page crashed/.test(text)) return "tab-crashed";
  if (/closed by (the )?user|user closed|cancel/.test(text)) return "closed-by-user";
  if (/no api|no request|no operation|nothing learned|not enough/.test(text)) return "no-api-found";
  return "failed";
}

function tabsOf(error: unknown): number[] {
  const tabs = (error as { browserTabs?: unknown } | null)?.browserTabs;
  return Array.isArray(tabs) ? tabs.filter((id): id is number => typeof id === "number") : [];
}

function leftOpenOf(error: unknown): number[] {
  const tabs = (error as { browserTabsLeftOpen?: unknown } | null)?.browserTabsLeftOpen;
  return Array.isArray(tabs) ? tabs.filter((id): id is number => typeof id === "number") : [];
}

/** Maps each site (a name, or a URL to start from) by using it; returns what was found per site. */
export async function explore(
  sites: string[],
  options: ExploreOptions = {},
): Promise<ExploreResult[]> {
  const model = requireModel(options.model);
  const quiet = options.quiet !== false;
  const requested = options.concurrency ?? options.parallel ?? (quiet ? 1 : 3);
  const parallel = Math.min(3, Math.max(1, requested));
  const seen = new Set<string>();
  const queue = sites.filter((site) => !seen.has(siteName(site)) && seen.add(siteName(site)));
  const results: ExploreResult[] = [];
  const settings = { ...options, quiet };
  const worker = async (): Promise<void> => {
    for (let site = queue.shift(); site; site = queue.shift()) {
      const result = await exploreOne(site, model, settings);
      results.push(result);
      options.onSite?.(result);
    }
  };
  await Promise.all(Array.from({ length: parallel }, worker));
  return results;
}
