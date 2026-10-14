// The data model shared by the service worker, the content script and the pages.

/** Where a boost applies. */
export type SiteRule =
  | { type: "domain"; value: string } // the host and its subdomains
  | { type: "prefix"; value: string } // URLs starting with this
  | { type: "url"; value: string } // exactly this URL
  | { type: "regex"; value: string } // a regular expression on the whole URL
  | { type: "match"; value: string } // a Chrome match pattern, as in @match
  | { type: "glob"; value: string } // a glob with * and ?, as in @include
  | { type: "all"; value?: string }; // every site

export type BoostKind = "boost" | "userscript" | "userstyle";
export type RunAt = "document-start" | "document-body" | "document-end" | "document-idle";

/** Hides elements, including ones that appear later. */
export interface Zap {
  selector: string;
  /** Only elements whose text includes this (case-insensitive). */
  contains?: string;
  /** What was clicked, for repair. */
  sample?: ElementSample;
}

/** Visual settings, turned into CSS. */
export interface Look {
  dark?: boolean;
  background?: string;
  text?: string;
  link?: string;
  font?: string;
  /** Text size, 1 is unchanged. */
  fontScale?: number;
  /** Percentages, 100 is unchanged. */
  brightness?: number;
  contrast?: number;
  saturation?: number;
  /** A readable column, in pixels. */
  maxWidth?: number;
  hideImages?: boolean;
}

/** Finds an element by selector, by text, or both. */
export interface Target {
  selector?: string;
  text?: string;
}

export type Action =
  | ({ do: "click" } & Target & ActionOptions)
  | ({ do: "remove" } & Target & ActionOptions)
  | ({ do: "fill"; value: string } & Target & ActionOptions)
  | ({ do: "select"; value: string } & Target & ActionOptions)
  | ({ do: "check"; value?: boolean } & Target & ActionOptions)
  | ({ do: "press"; key: string } & Target & ActionOptions)
  | ({ do: "scroll"; to?: "top" | "bottom" | "element" } & Target & ActionOptions)
  | ({ do: "wait"; ms: number } & ActionOptions)
  | ({
      do: "sort";
      /** Each item to reorder; items are moved within their parent. */
      items: string;
      /** The element inside each item holding the sort key. */
      key: string;
      numeric?: boolean;
      order?: "asc" | "desc";
    } & ActionOptions)
  | ({ do: "pauseMedia" } & ActionOptions);

export interface ActionOptions {
  /** "appear" (default) runs on matching elements now and whenever new ones appear; "load" runs once per page. */
  when?: "appear" | "load";
  /** Run the action at most this often per page. */
  times?: number;
}

/** A per-site network rule, through declarativeNetRequest. */
export interface NetworkRule {
  action: "block" | "allow" | "redirect" | "headers";
  /** A urlFilter ("||ads.example^", "*\/track*"); or use regex. */
  match?: string;
  regex?: string;
  /** Requests to any of these domains (and their subdomains). */
  domains?: string[];
  resourceTypes?: string[];
  redirect?: string;
  requestHeaders?: HeaderChange[];
  responseHeaders?: HeaderChange[];
  /** "from-site" (default): requests the boost's sites make. "to-site": requests to them. */
  scope?: "from-site" | "to-site" | "everywhere";
}

export interface HeaderChange {
  name: string;
  /** Set to this value; leave out to remove the header. */
  value?: string;
}

/** HTML added to the page. */
export interface HtmlPart {
  selector: string;
  position: "before" | "after" | "prepend" | "append" | "replace";
  html: string;
}

/** Parsed userscript or userstyle header. */
export interface ScriptMeta {
  name: string;
  namespace?: string;
  version?: string;
  description?: string;
  author?: string;
  homepage?: string;
  icon?: string;
  updateURL?: string;
  downloadURL?: string;
  supportURL?: string;
  license?: string;
  match: string[];
  include: string[];
  exclude: string[];
  excludeMatch: string[];
  grant: string[];
  require: string[];
  resource: { name: string; url: string }[];
  connect: string[];
  runAt?: RunAt | "context-menu";
  noframes?: boolean;
  injectInto?: "page" | "content" | "auto";
  tags: string[];
  antifeatures: string[];
  unwrap?: boolean;
  topLevelAwait?: boolean;
  preprocessor?: string;
  vars?: UserCssVar[];
  /** Every key as written, for GM_info. */
  raw: Record<string, string[]>;
}

export interface UserCssVar {
  name: string;
  type: "text" | "color" | "checkbox" | "select" | "dropdown" | "number" | "range" | "image";
  label: string;
  default: string;
  options?: { name: string; label: string; value: string }[];
  min?: number;
  max?: number;
  step?: number;
  units?: string;
}

/** A userstyle section: CSS for some sites. */
export interface StyleSection {
  sites: SiteRule[];
  css: string;
}

export interface ElementSample {
  tag: string;
  text?: string;
  attrs?: Record<string, string>;
}

export interface Boost {
  id: string;
  name: string;
  description?: string;
  kind: BoostKind;
  enabled: boolean;
  sites: SiteRule[];
  excludes?: SiteRule[];
  /** Runs earlier when lower. */
  order: number;
  tags: string[];
  created: number;
  updated: number;
  css?: string;
  sections?: StyleSection[];
  zaps?: Zap[];
  look?: Look;
  actions?: Action[];
  network?: NetworkRule[];
  html?: HtmlPart[];
  js?: string;
  /** "page" runs with the page's own globals; "isolated" keeps them apart. */
  jsWorld?: "page" | "isolated";
  runAt?: RunAt | "context-menu";
  allFrames?: boolean;
  /** Userscripts and userstyles keep their source and header. */
  source?: string;
  meta?: ScriptMeta;
  /** Fetched @require code, in order. */
  requires?: { url: string; code: string }[];
  resources?: Record<string, { url: string; mime: string; data: string }>;
  /** Userstyle variable values chosen by the user. */
  varValues?: Record<string, string>;
  /** Repair broken boosts automatically (needs a model). */
  autoRepair?: boolean;
  /** Where it came from. */
  origin?: {
    by: "ai" | "user" | "install" | "import" | "companion";
    url?: string;
    prompt?: string;
  };
  /** The conversation that wrote it, so it can be changed by talking. */
  chat?: ChatTurn[];
}

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

export interface Revision {
  at: number;
  by: "user" | "ai" | "repair" | "install" | "update" | "import" | "rollback" | "companion";
  note?: string;
  boost: Boost;
}

/** What a boost did on one visit. */
export interface HealthReport {
  url: string;
  /** "page": styles, zaps and actions; "script": JavaScript. */
  source: "page" | "script";
  at: number;
  /** Selectors from CSS, zaps and actions, and how many elements each matched. */
  selectors: { selector: string; count: number; sample?: ElementSample }[];
  actionsRun: number;
  errors: string[];
}

export interface Health {
  status: "ok" | "broken" | "unknown";
  last?: HealthReport;
  /** The last good visit for the page being repaired. */
  lastGood?: HealthReport;
  /** The last good visit per kind of page (source and URL shape). */
  good?: Record<string, HealthReport>;
  /** Selectors that matched before and now match nothing. */
  broken?: string[];
  /** Consecutive visits where something that used to match did not. */
  misses: number;
  repairedAt?: number;
  repairError?: string;
}

export type ProviderId = "anthropic" | "openai" | "gemini" | "openrouter" | "custom" | "companion";

export interface ModelSettings {
  provider: ProviderId;
  model: string;
  apiKey?: string;
  /** For "custom": an OpenAI-compatible base URL, such as http://localhost:11434/v1. */
  baseUrl?: string;
}

export interface Settings {
  model?: ModelSettings;
  /** Another extension that can lend its model and receive requests, by id. */
  companionId?: string;
  /** A local site-to-api server, for API boosts. */
  siteApi?: { url: string; token: string };
  autoRepair: boolean;
  showChip: boolean;
  /** Pause everything. */
  paused: boolean;
  /** Sites where nothing runs. */
  blocklist: string[];
  updates: { enabled: boolean; hours: number; apply: "auto" | "ask" };
  webdav?: { url: string; user?: string; password?: string; lastSync?: number };
}

export const DEFAULT_SETTINGS: Settings = {
  autoRepair: true,
  showChip: true,
  paused: false,
  blocklist: [],
  updates: { enabled: true, hours: 24, apply: "auto" },
};

/** What the content script needs for one page. */
export interface PagePlan {
  /** Every boost for this URL, including ones switched off (for the chip). */
  boosts: Boost[];
  /** The ones to apply. */
  active: string[];
  /** Boost ids switched off on this site only. */
  siteOff: string[];
  health: Record<string, Health>;
  showChip: boolean;
  /** Everything is off on this site, or everywhere. */
  siteDisabled: boolean;
  paused: boolean;
  /** JavaScript boosts need "Allow User Scripts". */
  setupNeeded: boolean;
  host: string;
}
