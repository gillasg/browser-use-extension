// help(topic) in browser code: the reference for everything used now and then, so the always-on
// tool guidance stays short. __hint(message) turns a failed cell's error into a "did you mean"
// from the real API surface, plus fixes for the Playwright habits that do not apply here.

const TOPICS: Record<string, string> = {
  tabs: "browser.openTab(url, {newTab?, window?: {width, height}}) opens a background tab (one per site: openTab on a site you have a tab for navigates it). browser.tabs(query?) lists {tabId, url, title, active, target}; browser.activeTab() is the user's current tab, attached and ready; bu.use(tabId) switches; browser.attachTab(target) uses a tab you did not open. browser.moveTab(tabIdOrPage | [ids], {index, windowId}) reorders tabs (index -1 = end). browser.pool(urls, async (tab, url) => ..., {concurrency}) works through many pages in parallel tabs, backing off on 429. browser.fetch(url) fetches with the user's cookies and no tab.",
  reading:
    "bu.state({selector, query, max}) scopes the observation. page.data() returns embedded JSON (JSON-LD, __NEXT_DATA__, app state) and metadata; page.data({summary: true}) lists its sources. page.table(css) returns rows keyed by header; page.links(css) {text, href}; page.markdown() clean main content; page.textContent(css); page.pdfText() for PDFs; await page.frames() for iframes. Locators: page.locator(css) / getByRole(role, {name}) / getByText / getByLabel / getByPlaceholder with .click() .fill(v) .innerText() .textContent() .inputValue() .getAttribute(n) .count() .all() .nth(i) .first() .allInnerTexts() .evaluate(fn) .boundingBox(); page.$eval / page.$$eval(css, fn).",
  history:
    "browser.history.search(text, {days, max}) returns visited pages {url, title, lastVisit, visits}. browser.bookmarks.search(text) / tree() / children(id) / create({title, url, parentId}) / update(id, {title, url}) / move(id, {parentId, index}) / remove(id). browser.downloads.list(text?) returns recent downloads with filename and state.",
  api: "siteApi.sites() and siteApi.operations(site) list what sites learned. siteApi.call(site, operation, params) reads; siteApi.watch(site, operation, params, {key}) returns only items new or changed since the last watch (also in routine checks). Writes: do one in the page; once the output says it was learned and proven, siteApi.write(site, operation, params) repeats it and siteApi.batch(site, operation, items, {perSecond, verify, label}) runs it over many items (paced, checks the first with verify(result, item), stops at the first error; continue what is left in the page, which repairs the operation). Paying, ordering, sending, posting, deleting and account changes stay in the page. siteApi.action(site, name, inputs) runs a saved multi-step action; siteApi.undo(site, operation, params) reverses a proven write whose opposite was learned; siteApi.channel(site, id, {send, seconds}) listens on a live channel.",
  network:
    "Every tab you act in is recorded for learning automatically. For a full capture: page.network.start({types: 'all', dryRun?}) then do the flow; dryRun blocks requests that would change something (send, post, buy), answering {} so the page goes on. page.network.list('/api' | {match, method}) summarizes, page.network.get(id) the full request and response, page.network.body(id) the parsed response, page.network.failures() groups failed requests with statuses, sizes, block headers and the last success, page.network.save(name) a HAR file. page.replay(id, {query, json, headers}) re-sends a recorded call from the page with its cookies, signatures and CSRF; page.request(url, {method, json, csrf: true}) makes a new one. page.session() returns cookies and storage.",
  skills:
    "Skills for the current site load by themselves (bu.state() says what they define). skills.list(url), skills.load(name). Save what took more than one try before answering: skills.save({name: 'site-task', domains: ['example.com'], description, examples, code}) where code is top-level declarations (const helper = async (...) => {...}) using page and bu, or a function returning an object of helpers. saveHelper(name, fn) / loadHelper(name) keep one function for this workspace.",
  progress:
    "Long jobs run in one cell: loop over every item and call bu.progress(done, total, label) as you go (the user sees 'label done/total'); checkpoint(name, value) saves progress so a reset can continue with loadCheckpoint(name).",
  recording:
    "browser.openTab(url, {window: {width, height}}) opens a visible window (Chrome only paints visible windows). page.recordTab({fps, name, seconds?}) saves frames plus frames.json, or returns {stop}. Locator actions return {box, tStart, tEnd}; page.mouse.move(x, y, {steps}); page.onCdp(event, handler) streams any DevTools event until stop(). page.diffScreenshot(before, {threshold, path}) compares screenshots; path writes a red-marked diff PNG.",
  demonstrations:
    "const demo = await page.recordDemonstration(); let the user do the task; const recording = await demo.stop() returns {steps, code, skill}. Review the code, set a clear name and domains, then skills.save(recording.skill). Password fields are redacted; never ask for a password in chat.",
  boosts:
    "Lasting changes to a site on every visit (hide parts, restyle, dark mode, auto-click a banner, block requests, a panel): browser.boosts.save({name, sites: ['example.com'], css?, zaps?: [{selector, contains?}], look?, actions?: [{do: 'click', text: 'Accept all'}], network?, js?}). browser.boosts.list(url), enable(id, false), remove(id); saving with an id replaces it. Check selectors on the page first.",
  rules:
    "Per-tab network rules: page.rules.block({ads, trackers, banners, images, media, fonts, urls}) for faster reading, page.rules.headers({...}), page.rules.mock(urlFilter, json), page.rules.clear(). Permission prompts cannot be clicked, so preset them: page.permissions.allow('location' | 'notifications' | 'camera' | 'microphone' | 'popups' | 'downloads') or block; page.setLocation(lat, lng). page.emulate({device: 'iPhone' | 'android' | 'ipad', colorScheme: 'dark', timezone, locale}) or {reset: true}.",
  media:
    "page.saveMedia(selectorOrUrl, {all?, name?, folder?}) saves images, videos or files with the user's cookies into the workspace; page.upload(selector, files) fills a file input (finds the hidden input behind a drop zone; workspace paths or URLs); page.download(url); page.pdf(name) saves the page as PDF; page.recordMedia(selector?, {seconds}) records a playing video or audio element (up to 50 s a call).",
  live: "page.waitForChange(selector?, {timeoutMs}) resolves when that part changes; page.waitForResponse(urlPart) with the next matching response; page.waitForMessage(textOrRegex) with the next WebSocket or event-stream message. siteApi.channel(site, id, {send, seconds}) for a mapped channel.",
  visual:
    "Only for canvases, maps, sliders, drag handles or controls without ids: page.screenshot({labels: true}) draws bu ids, then page.clickAt(x, y) / page.drag(x1, y1, x2, y2) in viewport coordinates; check with a fresh screenshot, then go back to bu.state().",
  debugging:
    "page.evaluate(fn, arg) runs page code and returns JSON; page.cdp(method, params) sends any DevTools command. page.console({errors: true}) returns console messages and errors (call once to start). Dialogs are accepted automatically; page.dialogs('dismiss') declines, page.dialogs('accept', text) answers prompts.",
  workspace:
    "artifact(name, data) writes a file (strings, bytes, Blobs; other objects as JSON); checkpoint(name, value) / loadCheckpoint(name) persist JSON across resets; showImage(path) shows an image.",
};

// Playwright and Puppeteer habits that look right and fail here.
const HABITS: Record<string, string> = {
  playwright:
    "there is no page.playwright: page itself is Playwright-style (page.locator, page.getByRole)",
  $: "page.$(css) is awaited and returns a handle or null, not a promise chain: use page.locator(css) and its methods",
  $x: "for XPath use page.locator('xpath=//...')",
  waitForTimeout:
    "never sleep blindly: page.waitForSelector(css), page.waitForChange(selector) or page.waitForResponse(urlPart)",
  type: "use locator.fill(text), or bu.type(id, text, {enter: true})",
  content: "use page.markdown() or page.data(), not the raw HTML",
  evaluateHandle: "use page.evaluate(fn, arg); it returns JSON",
  goBack: "use page.goto(url) with the URL you came from",
  catch: "await the call inside try/catch instead of chaining .catch on it",
  then: "await the call instead of chaining .then on it",
  click:
    "click a locator (page.getByRole('button', {name}).click()) or an observed id (bu.click(id))",
};

export const browserHelpApi = `
var __helpTopics = ${JSON.stringify(TOPICS)};
var __habits = ${JSON.stringify(HABITS)};
function help(topic) {
  var text = topic && __helpTopics[String(topic).toLowerCase()];
  if (!text) text = (topic ? 'No help topic ' + JSON.stringify(topic) + '. ' : '') + 'Topics: ' + Object.keys(__helpTopics).join(', ') + '. Call help(topic).';
  console.log(text);
  return text;
}
function __distance(a, b) {
  var row = Array.from({length: b.length + 1}, (_, i) => i);
  for (var i = 1; i <= a.length; i++) {
    var previous = row[0]; row[0] = i;
    for (var j = 1; j <= b.length; j++) {
      var current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length];
}
function __members(value) {
  var names = new Set();
  for (var item = value; item && item !== Object.prototype && item !== Function.prototype; item = Object.getPrototypeOf(item))
    for (var name of Object.getOwnPropertyNames(item)) if (!name.startsWith('_')) names.add(name);
  return [...names];
}
function __nearest(name, names) {
  var lower = name.toLowerCase();
  var scored = names.map(candidate => [candidate, candidate.toLowerCase().includes(lower) || lower.includes(candidate.toLowerCase()) ? 1 : __distance(lower, candidate.toLowerCase())]);
  return scored.filter(([, score]) => score <= Math.max(2, Math.floor(name.length / 3))).sort((a, b) => a[1] - b[1]).slice(0, 3).map(([candidate]) => candidate);
}
var __roots = {page: () => globalThis.page, browser: () => browser, bu: () => bu, siteApi: () => siteApi, skills: () => skills};
// Names the cell used that the real objects don't have: page.playwright, browser.history.find.
function __unknownMembers(code) {
  var found = [], seen = new Set(), pattern = /\\b(page|browser|bu|siteApi|skills)((?:\\.[A-Za-z_$][\\w$]*)+)/g, match;
  while ((match = pattern.exec(String(code || ''))) && found.length < 3) {
    var owner = __roots[match[1]](), path = [match[1]];
    for (var name of match[2].slice(1).split('.')) {
      if (owner == null || typeof owner !== 'object' && typeof owner !== 'function') break;
      var member; try { member = owner[name]; } catch { break; }
      if (member === undefined) {
        var key = path.join('.') + '.' + name;
        if (seen.has(key)) break;
        seen.add(key);
        var near = __nearest(name, __members(owner));
        found.push(__habits[name] || key + ' does not exist' + (near.length ? '; did you mean ' + near.map(n => path.join('.') + '.' + n).join(' or ') + '?' : ''));
        break;
      }
      owner = member; path.push(name);
    }
  }
  return found;
}
// "page.playwright.click is not a function", "foo is not defined", "reading 'x'".
function __hint(message, code) {
  try {
    var text = String(message || '');
    if (/is not a function|is not defined|Cannot read properties/.test(text)) {
      var unknown = __unknownMembers(code);
      if (unknown.length) return unknown.join('; ');
      var last = /([A-Za-z_$][\\w$]*) is not a function/.exec(text);
      if (last && __habits[last[1]]) return __habits[last[1]];
    }
    var call = /([A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)+)(?:\\(\\.\\.\\.\\))? is not a function/.exec(text);
    if (call) {
      var parts = call[1].split('.'), root = __roots[parts[0]];
      var name = parts[parts.length - 1], hints = [];
      if (__habits[parts[1]] && root) hints.push(__habits[parts[1]]);
      else if (__habits[name]) hints.push(__habits[name]);
      if (root) {
        var owner = root();
        for (var part of parts.slice(1, -1)) owner = owner == null ? owner : owner[part];
        if (owner != null && !hints.length) {
          var near = __nearest(name, __members(owner));
          if (near.length) hints.push('did you mean ' + near.map(n => parts.slice(0, -1).join('.') + '.' + n).join(' or ') + '?');
        }
      }
      return hints.join('; ');
    }
    var missing = /^([A-Za-z_$][\\w$]*) is not defined/.exec(text);
    if (missing) {
      var near = __nearest(missing[1], Object.getOwnPropertyNames(globalThis).filter(n => !n.startsWith('_')));
      return near.length ? 'did you mean ' + near.join(' or ') + '? (a saved skill defines its helpers when its site is observed)' : 'nothing called ' + missing[1] + ' exists here; help() lists what browser code can do';
    }
    if (/Cannot read properties of (undefined|null)/.test(text))
      return 'something returned ' + (/null/.test(text) ? 'null' : 'undefined') + ' (page.$ returns null when nothing matches; locators wait for the element instead)';
  } catch {}
  return '';
}
`;
