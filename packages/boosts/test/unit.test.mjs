// The pure parts: matching, userscript and userstyle headers, CSS, network rules, diffs, reviews,
// bundles, model answers and health.
import assert from "node:assert/strict";
import test from "node:test";
import { zipSync } from "fflate";
import {
  authorMessages,
  boostCss,
  boostFromSource,
  boostMatches,
  chromePatterns,
  compareVersions,
  cssSelectors,
  diffLines,
  extractJson,
  fromZip,
  globToRegex,
  lookCss,
  mayConnect,
  nextHealth,
  networkRules,
  normalizeBoost,
  pageKey,
  parseAuthorAnswer,
  parseBundle,
  parseShareCode,
  parseUserScript,
  parseUserStyle,
  reviewBoost,
  ruleMatches,
  ruleRegexSource,
  sectionsCss,
  shareCode,
  styleSections,
  toBundle,
  toZip,
  unifiedDiff,
} from "../build-test/lib.mjs";

test("site rules match the URLs they should", () => {
  assert.ok(ruleMatches({ type: "domain", value: "example.com" }, "https://www.example.com/a"));
  assert.ok(ruleMatches({ type: "domain", value: "www.example.com" }, "https://example.com/"));
  assert.ok(!ruleMatches({ type: "domain", value: "example.com" }, "https://notexample.com/"));
  assert.ok(
    ruleMatches(
      { type: "match", value: "*://*.example.com/news/*" },
      "http://m.example.com:8080/news/1",
    ),
  );
  assert.ok(!ruleMatches({ type: "match", value: "https://example.com/*" }, "http://example.com/"));
  assert.ok(
    ruleMatches(
      { type: "glob", value: "https://shop.example.tld/*" },
      "https://shop.example.co.uk/p",
    ),
  );
  assert.ok(
    ruleMatches({ type: "glob", value: "/^https:\\/\\/a\\.test\\/x\\d+$/" }, "https://a.test/x12"),
  );
  assert.ok(ruleMatches({ type: "prefix", value: "https://a.test/docs" }, "https://a.test/docs/1"));
  assert.ok(ruleMatches({ type: "regex", value: "https://a\\.test/\\d+" }, "https://a.test/42"));
  assert.ok(
    boostMatches(
      { sites: [{ type: "all" }], excludes: [{ type: "domain", value: "bank.test" }] },
      "https://news.test/",
    ),
  );
  assert.ok(
    !boostMatches(
      { sites: [{ type: "all" }], excludes: [{ type: "domain", value: "bank.test" }] },
      "https://my.bank.test/",
    ),
  );
});

test("in-page checks agree with the matcher, and registration patterns cover them", () => {
  const rules = [
    { type: "domain", value: "example.com" },
    { type: "match", value: "https://*.example.org/a/*" },
    { type: "glob", value: "*://*.example.net/*" },
    { type: "prefix", value: "https://x.test/p?q=1" },
  ];
  const urls = [
    "https://example.com/",
    "https://sub.example.com:444/x",
    "https://a.example.org/a/b",
    "https://a.example.org/b",
    "http://www.example.net/z",
    "https://x.test/p?q=1&r=2",
    "https://other.test/",
  ];
  for (const rule of rules)
    for (const url of urls)
      assert.equal(
        new RegExp(ruleRegexSource(rule), "i").test(url),
        ruleMatches(rule, url),
        `${rule.type} ${rule.value} on ${url}`,
      );
  assert.deepEqual(chromePatterns([{ type: "domain", value: "example.com" }]), [
    "*://example.com/*",
    "*://*.example.com/*",
  ]);
  assert.deepEqual(chromePatterns([{ type: "glob", value: "*.tld/*" }]), ["<all_urls>"]);
  assert.ok(globToRegex("https://a.test/*").test("https://a.test/anything?at=all"));
});

const SCRIPT = `// ==UserScript==
// @name         Demo
// @name:fr      Démo
// @namespace    https://demo.test
// @version      2.10.1
// @description  Does things
// @author       Someone
// @match        https://a.test/*
// @include      /^https:\\/\\/b\\.test\\//
// @exclude      https://a.test/private/*
// @exclude-match https://a.test/admin/*
// @require      https://cdn.test/lib.js#sha256=abc
// @resource     logo https://cdn.test/logo.png
// @connect      api.test
// @connect      self
// @grant        GM_xmlhttpRequest
// @grant        GM.getValue
// @run-at       document-start
// @noframes
// @inject-into  content
// @tag          productivity, shopping
// @antifeature  ads Shows a banner
// @updateURL    https://demo.test/demo.meta.js
// @downloadURL  https://demo.test/demo.user.js
// ==/UserScript==
console.log(1);`;

test("userscript headers: every key, and a boost from them", () => {
  const meta = parseUserScript(SCRIPT);
  assert.equal(meta.name, "Demo");
  assert.equal(meta.version, "2.10.1");
  assert.deepEqual(meta.match, ["https://a.test/*"]);
  assert.deepEqual(meta.include, ["/^https:\\/\\/b\\.test\\//"]);
  assert.deepEqual(meta.exclude, ["https://a.test/private/*"]);
  assert.deepEqual(meta.excludeMatch, ["https://a.test/admin/*"]);
  assert.deepEqual(meta.resource, [{ name: "logo", url: "https://cdn.test/logo.png" }]);
  assert.deepEqual(meta.connect, ["api.test", "self"]);
  assert.equal(meta.runAt, "document-start");
  assert.equal(meta.noframes, true);
  assert.equal(meta.injectInto, "content");
  assert.deepEqual(meta.tags, ["productivity", "shopping"]);
  assert.equal(meta.downloadURL, "https://demo.test/demo.user.js");
  const boost = boostFromSource(SCRIPT, "x");
  assert.equal(boost.kind, "userscript");
  assert.equal(boost.jsWorld, "isolated");
  assert.equal(boost.allFrames, false);
  assert.ok(boostMatches(boost, "https://a.test/page"));
  assert.ok(boostMatches(boost, "https://b.test/page"));
  assert.ok(!boostMatches(boost, "https://a.test/private/1"));
  assert.ok(!boostMatches(boost, "https://a.test/admin/1"));
  assert.ok(compareVersions("2.10.1", "2.9") > 0);
  assert.ok(compareVersions("1.0", "1.0.0") === 0);
  assert.throws(() => parseUserScript("console.log(1)"), /No ==UserScript== header/);
});

const STYLE = `/* ==UserStyle==
@name         Dark demo
@namespace    demo
@version      1.0.0
@preprocessor default
@var color bg "Background" #101010
@var checkbox rounded "Rounded corners" 1
@var select size "Size" {
  small "Small" <<<EOT 12px EOT;
  big "Big*" <<<EOT 18px EOT;
}
@var range gap "Gap" [8, 0, 20, 2, "px"]
==/UserStyle== */
@-moz-document domain("a.test"), url-prefix("https://b.test/docs") {
  body { background: var(--bg); font-size: var(--size); }
}
@-moz-document regexp("https://c\\\\.test/.*") {
  p { margin: var(--gap); }
}
html { scrollbar-width: thin; }`;

test("userstyles: variables, sections and their CSS", () => {
  const meta = parseUserStyle(STYLE);
  assert.deepEqual(
    meta.vars.map((v) => [v.name, v.type, v.default]),
    [
      ["bg", "color", "#101010"],
      ["rounded", "checkbox", "1"],
      ["size", "select", "big"],
      ["gap", "range", "8"],
    ],
  );
  const sections = styleSections(STYLE);
  assert.equal(sections.length, 3);
  assert.deepEqual(sections[0].sites, [{ type: "all" }]);
  assert.deepEqual(
    sections[1].sites.map((s) => s.type),
    ["domain", "prefix"],
  );
  const boost = boostFromSource(STYLE, "s");
  const css = sectionsCss(boost, "https://a.test/");
  assert.match(css, /--bg: #101010;/);
  assert.match(css, /--size: 18px;/);
  assert.match(css, /--gap: 8px;/);
  assert.match(css, /scrollbar-width/);
  assert.doesNotMatch(css, /margin/, "a section for another site is left out");
  assert.match(
    sectionsCss({ ...boost, varValues: { size: "small" } }, "https://b.test/docs/1"),
    /--size: 12px;/,
  );
  assert.match(sectionsCss(boost, "https://c.test/x"), /margin/);
});

test("look settings, zaps and selectors in CSS", () => {
  const css = lookCss({
    dark: true,
    brightness: 90,
    font: "Georgia",
    maxWidth: 700,
    hideImages: true,
  });
  assert.match(css, /filter: invert\(0\.92\) hue-rotate\(180deg\) brightness\(90%\)/);
  assert.match(css, /font-family: Georgia/);
  assert.match(css, /max-width: 700px/);
  assert.equal(lookCss({}), "");
  const all = boostCss(
    {
      css: "a { color: red }",
      zaps: [{ selector: ".ad" }, { selector: ".card", contains: "Promoted" }],
      sites: [],
    },
    "https://a.test/",
  );
  assert.match(all, /\.ad \{ display: none !important; \}/);
  assert.doesNotMatch(all, /\.card/, "text zaps run in script");
  assert.deepEqual(
    cssSelectors(
      "/* x */ .a, .b:hover { x: 1 } @media (max-width: 1px) { .c::before { y: 2 } } @keyframes k { from { a: 1 } to { a: 2 } }",
    ),
    [".a", ".c"],
  );
});

test("network rules are scoped to the boost's sites", () => {
  const rules = networkRules(
    {
      sites: [{ type: "domain", value: "news.test" }],
      network: [
        { action: "block", domains: ["ads.test"] },
        {
          action: "headers",
          requestHeaders: [{ name: "Accept-Language", value: "hi-IN" }, { name: "X-Remove" }],
        },
        { action: "redirect", regex: "^https://old\\.test/(.*)", redirect: "https://new.test/\\1" },
      ],
    },
    10,
  );
  assert.deepEqual(rules[0], {
    id: 10,
    priority: 2,
    action: { type: "block" },
    condition: { requestDomains: ["ads.test"], initiatorDomains: ["news.test"] },
  });
  assert.deepEqual(rules[1].action.requestHeaders, [
    { header: "Accept-Language", operation: "set", value: "hi-IN" },
    { header: "X-Remove", operation: "remove" },
  ]);
  assert.deepEqual(rules[1].condition.requestDomains, ["news.test"]);
  assert.ok(rules[1].condition.resourceTypes.includes("main_frame"));
  assert.deepEqual(rules[2].action.redirect, { regexSubstitution: "https://new.test/\\1" });
});

test("diffs show what changed", () => {
  assert.deepEqual(diffLines("a\nb\nc", "a\nc\nd"), [
    { kind: " ", text: "a" },
    { kind: "-", text: "b" },
    { kind: " ", text: "c" },
    { kind: "+", text: "d" },
  ]);
  assert.equal(unifiedDiff("1\n2\n3\n4\n5\n6\n7", "1\n2\n3\n4\n5\n6\nX", 1), "…\n  6\n- 7\n+ X");
});

test("reviews flag what a boost can do", () => {
  assert.equal(
    reviewBoost({ sites: [{ type: "domain", value: "a.test" }], css: "a{}" }).level,
    "low",
  );
  const script = boostFromSource(SCRIPT, "x");
  const review = reviewBoost(script);
  assert.equal(review.level, "high");
  assert.ok(review.warnings.includes("Can send requests, with your logins, to: api.test, self"));
  assert.ok(review.warnings.some((w) => /shows ads/.test(w)));
  assert.match(review.lines.join("\n"), /Loads code from: https:\/\/cdn\.test\/lib\.js/);
});

test("bundles, share codes and ZIPs round-trip", () => {
  const boost = normalizeBoost({
    name: "Mine",
    sites: ["a.test", "https://b.test/*"],
    css: "x{}",
    chat: [{ role: "user", text: "secret plans" }],
  });
  assert.deepEqual(boost.sites, [
    { type: "domain", value: "a.test" },
    { type: "match", value: "https://b.test/*" },
  ]);
  const code = shareCode([boost]);
  const back = parseShareCode(code).boosts[0];
  assert.equal(back.css, "x{}");
  assert.equal(back.chat, undefined, "conversations are not shared");
  const script = boostFromSource(SCRIPT, "s");
  const zipped = fromZip(toZip(toBundle([boost, script])));
  assert.deepEqual(
    zipped.boosts.map((b) => b.name),
    ["Mine", "Demo"],
  );
  assert.equal(parseBundle(SCRIPT).boosts[0].kind, "userscript");
  const loose = fromZip(looseZip([script]));
  assert.equal(loose.boosts[0].meta.name, "Demo", "a ZIP of plain .user.js files imports too");
});

/** A ZIP someone made by hand: just the scripts, no index file. */
function looseZip(boosts) {
  return zipSync(
    Object.fromEntries(
      boosts.map((b) => [`${b.name}.user.js`, new TextEncoder().encode(b.source)]),
    ),
  );
}

test("the model's answer becomes a boost, keeping the one being changed", () => {
  assert.deepEqual(extractJson('Sure!\n```json\n{"a": "}"}\n```\nDone'), { a: "}" });
  assert.deepEqual(extractJson('{"reply": "x", "boost": {"name": "{}"}} trailing'), {
    reply: "x",
    boost: { name: "{}" },
  });
  assert.throws(() => extractJson("no json here"), /did not answer with JSON/);
  const current = normalizeBoost({
    id: "keep-me",
    name: "Old",
    sites: ["a.test"],
    css: "a{}",
    zaps: [{ selector: ".x" }],
    created: 5,
    tags: ["t"],
  });
  const page = { url: "https://a.test/p", title: "P", outline: "body" };
  const answer =
    '```json\n{"reply": "Swapped the style for a zap", "boost": {"name": "New", "zaps": [{"selector": ".y"}]}}\n```';
  const result = parseAuthorAnswer(
    answer,
    { request: "change it", page, current, history: [] },
    { type: "domain", value: "a.test" },
  );
  assert.equal(result.boost.id, "keep-me");
  assert.equal(result.boost.created, 5);
  assert.deepEqual(result.boost.tags, ["t"]);
  assert.equal(result.boost.css, undefined, "parts the model dropped are removed");
  assert.deepEqual(result.boost.zaps, [{ selector: ".y" }]);
  assert.deepEqual(result.boost.sites, current.sites);
  assert.equal(result.boost.chat.length, 2);
  const messages = authorMessages({
    request: "hide ads",
    page: { ...page, picked: { selectors: [".ad"], html: "<div class=ad>", ancestors: ["main"] } },
    history: [
      { role: "user", text: "hi" },
      { role: "assistant", text: "hello" },
    ],
  });
  assert.equal(messages.length, 3);
  assert.match(messages[2].content, /pointed at this element[\s\S]*\.ad[\s\S]*Request: hide ads/);
});

test("health: a selector that matched before and stops counts as broken after two visits", () => {
  const visit = (url, count, errors = []) => ({
    url,
    source: "page",
    at: 1,
    selectors: [{ selector: ".side", count }],
    actionsRun: 0,
    errors,
  });
  let health = { status: "unknown", misses: 0 };
  health = nextHealth(health, visit("https://a.test/p/1", 1));
  assert.equal(health.status, "ok");
  health = nextHealth(health, visit("https://a.test/", 0));
  assert.equal(health.status, "ok", "a different kind of page never had it");
  health = nextHealth(health, visit("https://a.test/p/2", 0));
  assert.equal(health.status, "ok", "one miss is not enough");
  health = nextHealth(health, visit("https://a.test/p/3", 0));
  assert.equal(health.status, "broken");
  assert.deepEqual(health.broken, [".side"]);
  assert.equal(health.lastGood.url, "https://a.test/p/1");
  assert.equal(nextHealth(health, visit("https://a.test/p/4", 2)).status, "ok");
  assert.equal(
    pageKey("https://a.test/p/123/reviews", "page"),
    pageKey("https://a.test/p/987/reviews", "page"),
  );
});

test("scripts reach only the hosts they declare", () => {
  assert.ok(mayConnect("https://api.test/x", "https://a.test/", ["api.test"]));
  assert.ok(mayConnect("https://v2.api.test/x", "https://a.test/", ["api.test"]));
  assert.ok(mayConnect("https://a.test/data", "https://a.test/", []), "its own site");
  assert.ok(!mayConnect("https://evil.test/", "https://a.test/", ["api.test"]));
  assert.ok(mayConnect("https://evil.test/", "https://a.test/", ["*"]));
  assert.ok(mayConnect("http://127.0.0.1:9/", "https://a.test/", ["localhost"]));
  assert.ok(
    mayConnect("https://anything.test/", "https://a.test/", undefined),
    "boosts can reach any site",
  );
});
