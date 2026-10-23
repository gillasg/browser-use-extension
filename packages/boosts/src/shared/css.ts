import type { Boost, Look, StyleSection, Zap } from "./types.js";
import { ruleMatches } from "./match.js";
import { varValue } from "./userscript.js";

// Everything a boost turns into CSS: its own styles, look settings, zaps and userstyle sections.

const MEDIA =
  "img, video, picture, canvas, iframe, embed, object, svg image, [style*='background-image']";

function filters(look: Look): string[] {
  const parts: string[] = [];
  if (look.dark) parts.push("invert(0.92)", "hue-rotate(180deg)");
  if (look.brightness !== undefined && look.brightness !== 100)
    parts.push(`brightness(${look.brightness}%)`);
  if (look.contrast !== undefined && look.contrast !== 100)
    parts.push(`contrast(${look.contrast}%)`);
  if (look.saturation !== undefined && look.saturation !== 100)
    parts.push(`saturate(${look.saturation}%)`);
  return parts;
}

function colours(look: Look): string[] {
  const rules: string[] = [];
  if (look.background)
    rules.push(
      `html, body { background: ${look.background} !important; }`,
      `body * { background-color: transparent !important; }`,
    );
  if (look.text) rules.push(`body, body *:not(a) { color: ${look.text} !important; }`);
  if (look.link) rules.push(`a, a * { color: ${look.link} !important; }`);
  return rules;
}

export function lookCss(look: Look | undefined): string {
  if (!look) return "";
  const rules: string[] = [];
  const filter = filters(look);
  if (filter.length) {
    rules.push(`html { filter: ${filter.join(" ")} !important; }`);
    if (look.dark)
      rules.push(
        `html { background: #fff !important; }`,
        `${MEDIA} { filter: invert(1) hue-rotate(180deg) !important; }`,
      );
  }
  rules.push(...colours(look));
  if (look.font)
    rules.push(
      `body, body *:not(code):not(pre):not(kbd):not(samp):not(i):not([class*="icon" i]):not([class*="symbol" i]) { font-family: ${look.font} !important; }`,
    );
  if (look.fontScale && look.fontScale !== 1)
    rules.push(`body { zoom: ${look.fontScale} !important; }`);
  if (look.maxWidth)
    rules.push(
      `body { max-width: ${look.maxWidth}px !important; margin-left: auto !important; margin-right: auto !important; }`,
    );
  if (look.hideImages)
    rules.push(`img, picture, video, svg image { visibility: hidden !important; }`);
  return rules.join("\n");
}

/** Zaps without a text condition can be plain CSS (no flash); the rest run in script. */
export function zapCss(zaps: Zap[] | undefined): string {
  const plain = (zaps ?? []).filter((zap) => !zap.contains).map((zap) => zap.selector);
  return plain.length ? `${plain.join(",\n")} { display: none !important; }` : "";
}

/** A userstyle's CSS for one URL, with its variables filled in. */
export function sectionsCss(boost: Boost, url: string): string {
  const sections: StyleSection[] = boost.sections ?? [];
  const css = sections
    .filter((section) => section.sites.some((rule) => ruleMatches(rule, url)))
    .map((section) => section.css)
    .join("\n");
  return css ? withVars(boost, css) : "";
}

function withVars(boost: Boost, css: string): string {
  const vars = boost.meta?.vars ?? [];
  if (!vars.length) return css;
  const values = Object.fromEntries(
    vars.map((v) => [v.name, varValue(v, boost.varValues?.[v.name])]),
  );
  const preprocessor = boost.meta?.preprocessor ?? "default";
  if (preprocessor === "uso")
    return css.replace(/\/\*\[\[([\w-]+)\]\]\*\//g, (whole, name: string) => values[name] ?? whole);
  if (preprocessor === "less" || preprocessor === "stylus") return css; // compiled when saved
  const declarations = Object.entries(values)
    .map(([name, value]) => `  --${name}: ${value};`)
    .join("\n");
  return `:root {\n${declarations}\n}\n${css}`;
}

/** All CSS a boost adds to one page. */
export function boostCss(boost: Boost, url: string): string {
  return [boost.css ?? "", lookCss(boost.look), zapCss(boost.zaps), sectionsCss(boost, url)]
    .filter(Boolean)
    .join("\n");
}

/** Selectors in a style sheet, for health checks (at-rules and pseudo-elements skipped). */
export function cssSelectors(css: string): string[] {
  const selectors = new Set<string>();
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const found of stripped.matchAll(/([^{}@;]+)\{[^{}]*\}/g)) {
    for (const part of (found[1] ?? "").split(",")) {
      const selector = part
        .trim()
        .replace(
          /::?(before|after|placeholder|selection|marker|backdrop|first-line|first-letter)\b.*$/i,
          "",
        );
      if (!selector || /^(from|to|\d+%|html|body|:root|\*)$/i.test(selector)) continue;
      if (/:(hover|focus|active|visited|focus-within|focus-visible)/.test(selector)) continue;
      selectors.add(selector);
    }
  }
  return [...selectors];
}
