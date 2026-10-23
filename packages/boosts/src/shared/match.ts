import type { Boost, SiteRule } from "./types.js";

// URL matching for every kind of site rule, plus the coarse Chrome match patterns used to
// register scripts (the exact check runs again in the page).

const escape = (text: string): string => text.replace(/[.+?^${}()|[\]\\/]/g, "\\$&");
const TLDS =
  "(?:com|net|org|io|co|de|uk|co\\.uk|fr|in|co\\.in|jp|ru|br|it|es|nl|ca|au|info|app|dev)";

/** A glob as in @include: * is anything, and ".tld" is any common top-level domain. */
export function globToRegex(glob: string): RegExp {
  if (glob.length > 2 && glob.startsWith("/") && glob.lastIndexOf("/") > 0) {
    const end = glob.lastIndexOf("/");
    try {
      return new RegExp(glob.slice(1, end), glob.slice(end + 1).replace(/[^imsu]/g, ""));
    } catch {
      return /$^/;
    }
  }
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i] as string;
    if (char === "*") source += ".*";
    else if (glob.startsWith(".tld", i) && /[/:]|$/.test(glob[i + 4] ?? "")) {
      source += "\\." + TLDS;
      i += 3;
    } else source += escape(char);
  }
  return new RegExp(`^${source}$`, "i");
}

/** A Chrome match pattern, as in @match. */
export function matchPatternToRegex(pattern: string): RegExp {
  if (pattern === "<all_urls>" || pattern === "*") return /^(?:https?|file|ftp):\/\//i;
  const parsed = /^(\*|https?|file|ftp|wss?):\/\/([^/]*)(\/.*)?$/i.exec(pattern);
  if (!parsed) return /$^/;
  const [, scheme = "*", host = "", path = "/*"] = parsed;
  const schemeSource = scheme === "*" ? "https?" : escape(scheme);
  let hostSource: string;
  if (host === "*") hostSource = "[^/]*";
  else if (host.startsWith("*.")) hostSource = `(?:[^/]*\\.)?${escape(host.slice(2))}`;
  else hostSource = escape(host);
  // A pattern's host has no port, so any port matches it.
  const pathSource = path.split("*").map(escape).join(".*");
  return new RegExp(`^${schemeSource}:\\/\\/${hostSource}(?::\\d+)?${pathSource}$`, "i");
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function ruleMatches(rule: SiteRule, url: string): boolean {
  switch (rule.type) {
    case "all":
      return /^(?:https?|file):/i.test(url);
    case "domain": {
      const host = hostOf(url);
      const domain = rule.value.toLowerCase().replace(/^www\./, "");
      return host === domain || host.endsWith("." + domain);
    }
    case "prefix":
      return url.startsWith(rule.value);
    case "url":
      return url === rule.value;
    case "regex":
      return safeRegex(rule.value).test(url);
    case "match":
      return matchPatternToRegex(rule.value).test(url);
    case "glob":
      return globToRegex(rule.value).test(url);
  }
}

function safeRegex(source: string): RegExp {
  try {
    return new RegExp(source.startsWith("^") ? source : `^(?:${source})$`);
  } catch {
    return /$^/;
  }
}

/** Whether a boost applies to a URL: any site rule matches and no exclusion does. */
export function boostMatches(boost: Pick<Boost, "sites" | "excludes">, url: string): boolean {
  if (!boost.sites.some((rule) => ruleMatches(rule, url))) return false;
  return !(boost.excludes ?? []).some((rule) => ruleMatches(rule, url));
}

/** Coarse match patterns for chrome.userScripts.register: a superset of what really matches. */
export function chromePatterns(rules: SiteRule[]): string[] {
  const patterns = new Set<string>();
  for (const rule of rules) {
    for (const pattern of patternsFor(rule)) patterns.add(pattern);
  }
  return [...patterns];
}

function patternsFor(rule: SiteRule): string[] {
  switch (rule.type) {
    case "domain": {
      const domain = rule.value.toLowerCase().replace(/^www\./, "");
      return [`*://${domain}/*`, `*://*.${domain}/*`];
    }
    case "match":
      return [rule.value === "*" ? "<all_urls>" : rule.value];
    case "prefix":
    case "url": {
      const host = hostOf(rule.value);
      return host ? [`*://${host}/*`] : ["<all_urls>"];
    }
    case "glob":
      return [globHostPattern(rule.value)];
    default:
      return ["<all_urls>"];
  }
}

/** The host part of a glob, when it is a plain one, gives a narrower pattern. */
function globHostPattern(glob: string): string {
  const parsed = /^(?:\*|https?):\/\/([a-z0-9.-]+)\//i.exec(glob);
  return parsed?.[1] && !parsed[1].includes(".tld") ? `*://${parsed[1]}/*` : "<all_urls>";
}

/** A rule for the site of a URL: its registrable-looking domain without "www.". */
export function siteRuleFor(url: string): SiteRule {
  return { type: "domain", value: hostOf(url).replace(/^www\./, "") };
}

/** Plain-English description of a rule, for the review page and the manager. */
export function describeRule(rule: SiteRule): string {
  switch (rule.type) {
    case "all":
      return "every site";
    case "domain":
      return rule.value;
    case "prefix":
      return `pages starting with ${rule.value}`;
    case "url":
      return rule.value;
    case "regex":
      return `URLs matching /${rule.value}/`;
    default:
      return rule.value === "<all_urls>" || rule.value === "*" ? "every site" : rule.value;
  }
}

/** Hosts a rule names, for network rules (declarativeNetRequest needs domains). */
export function ruleDomains(rules: SiteRule[]): string[] | undefined {
  const domains: string[] = [];
  for (const rule of rules) {
    if (rule.type === "domain") domains.push(rule.value.replace(/^www\./, ""));
    else if (rule.type === "prefix" || rule.type === "url") domains.push(hostOf(rule.value));
    else if (rule.type === "match") {
      const host = /^[^:]+:\/\/(?:\*\.)?([^/*]+)\//.exec(rule.value)?.[1];
      if (!host) return undefined;
      domains.push(host);
    } else return undefined;
  }
  return [...new Set(domains.filter(Boolean))];
}

/** A regular expression (source, case-insensitive) equivalent to a rule, for checks inside pages. */
export function ruleRegexSource(rule: SiteRule): string {
  switch (rule.type) {
    case "all":
      return "^(?:https?|file):";
    case "domain": {
      const domain = escape(rule.value.toLowerCase().replace(/^www\./, ""));
      return (
        String.raw`^[a-z][a-z0-9+.-]*:\/\/(?:[^/]*\.)?` + domain + String.raw`(?::\d+)?(?:[/?#]|$)`
      );
    }
    case "prefix":
      return "^" + escape(rule.value);
    case "url":
      return `^${escape(rule.value)}$`;
    case "regex":
      return safeRegex(rule.value).source;
    case "match":
      return matchPatternToRegex(rule.value).source;
    case "glob":
      return globToRegex(rule.value).source;
  }
}
