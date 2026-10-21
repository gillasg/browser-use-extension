// Data helpers for browser_code: calling a site's endpoints from inside its page, the page's
// embedded data and metadata, clean Markdown, session export, fetching without a tab, and a
// pool that works through many URLs in parallel tabs. Evaluated in the sandbox realm.
export const browserDataApi = `
// Headers the browser sets itself; a replayed request must not carry the recorded copies.
var __replayDropped = /^(:|host$|connection$|content-length$|cookie$|origin$|referer$|accept-encoding$|keep-alive$|transfer-encoding$|te$|upgrade$|via$|proxy-|sec-|priority$)/i;

function __pageRequest(request) {
  return (async () => {
    var headers = new Headers(request.headers || {});
    if (request.csrf) {
      var meta = document.querySelector('meta[name="csrf-token"],meta[name="_csrf"],meta[name="csrf"],meta[name="x-csrf-token"]');
      var cookie = document.cookie.match(/(?:^|; )(?:XSRF-TOKEN|xsrf-token|csrftoken|_csrf|csrf_token)=([^;]+)/);
      var token = (meta && meta.getAttribute('content')) || (cookie && decodeURIComponent(cookie[1]));
      if (token && !headers.has('x-csrf-token')) headers.set('x-csrf-token', token);
      if (token && cookie && !headers.has('x-xsrf-token')) headers.set('x-xsrf-token', token);
    }
    var body = request.json !== undefined ? JSON.stringify(request.json) : request.body;
    if (request.json !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json');
    var response = await fetch(request.url, {method: request.method || 'GET', headers, body,
      credentials: request.credentials || 'include', redirect: 'follow'});
    var text = await response.text();
    var result = {status: response.status, ok: response.ok, url: response.url,
      headers: Object.fromEntries(response.headers)};
    try { result.json = JSON.parse(text); } catch { result.text = text.slice(0, 2000000); }
    return result;
  })();
}

function __readMetadata() {
  var meta = {};
  document.querySelectorAll('meta[property],meta[name]').forEach((tag) => {
    var key = tag.getAttribute('property') || tag.getAttribute('name');
    var value = tag.getAttribute('content');
    if (key && value && /^(og:|twitter:|article:|product:|description$|keywords$|author$|robots$)/i.test(key)) meta[key] = value;
  });
  var link = (rel) => document.querySelector('link[rel="' + rel + '"]')?.href;
  return {
    url: location.href, title: document.title, lang: document.documentElement.lang || undefined,
    description: meta.description, canonical: link('canonical'), icon: link('icon') || link('shortcut icon'),
    alternates: [...document.querySelectorAll('link[rel="alternate"][hreflang]')].map((tag) => ({lang: tag.hreflang, url: tag.href})),
    meta,
  };
}

// Runs in the page, so the metadata reader is passed in rather than referenced.
function __readPageData(readMetadata, options) {
  var parse = (text) => { try { return JSON.parse(text); } catch { return undefined; } };
  var plain = (value) => { try { return JSON.parse(JSON.stringify(value)); } catch { return undefined; } };
  var data = {};
  var jsonLd = [...document.querySelectorAll('script[type="application/ld+json"]')].map((tag) => parse(tag.textContent)).filter(Boolean);
  if (jsonLd.length) data.jsonLd = jsonLd;
  var next = document.getElementById('__NEXT_DATA__');
  if (next) data.nextData = parse(next.textContent);
  for (var name of ['__NUXT__', '__NUXT_DATA__', '__APOLLO_STATE__', '__INITIAL_STATE__', '__PRELOADED_STATE__', '__REDUX_STATE__', '__INITIAL_DATA__', '__DATA__', '__STATE__', '__remixContext', '__staticRouterHydrationData']) {
    var value = window[name];
    if (value && typeof value === 'object') { var copy = plain(value); if (copy !== undefined) data[name] = copy; }
  }
  if (Array.isArray(window.__next_f))
    data.nextFlight = window.__next_f.map((chunk) => chunk && chunk[1]).filter((chunk) => typeof chunk === 'string').join('').slice(0, 1000000);
  var scripts = [...document.querySelectorAll('script[type="application/json"]')]
    .filter((tag) => tag.id !== '__NEXT_DATA__' && tag.textContent.length < 3000000)
    .map((tag) => ({id: tag.id || undefined, data: parse(tag.textContent)})).filter((item) => item.data !== undefined);
  if (scripts.length) data.jsonScripts = scripts;
  if (options && options.summary) {
    var sources = {};
    for (var source of Object.keys(data)) {
      var item = data[source];
      if (Array.isArray(item)) sources[source] = {items: item.length};
      else if (item && typeof item === 'object') {
        var arrays = {};
        for (var field of Object.keys(item)) if (Array.isArray(item[field])) arrays[field] = item[field].length;
        sources[source] = {keys: Object.keys(item).slice(0, 10), arrays: arrays};
      } else sources[source] = {};
    }
    var params = [];
    try { params = [...new URL(location.href).searchParams.keys()]; } catch {}
    return {sources: sources, urlParams: params};
  }
  data.metadata = readMetadata();
  return data;
}

// HTML to Markdown, in the page: headings, paragraphs, lists, links, emphasis, code, quotes,
// images and tables. With mainOnly, navigation, headers, footers and asides are skipped.
function __readMarkdown(options) {
  var skip = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|CANVAS|IFRAME|OBJECT|SELECT|BUTTON|INPUT|TEXTAREA)$/;
  var chrome = /^(NAV|HEADER|FOOTER|ASIDE|FORM)$/;
  var noise = /(^|[-_ ])(nav|menu|footer|header|sidebar|cookie|consent|banner|share|social|related|newsletter|breadcrumb|advert|promo|popup|modal)([-_ ]|$)/i;
  var root = options.selector ? document.querySelector(options.selector) : (options.mainOnly === false ? document.body :
    document.querySelector('main, article, [role="main"], #main, #content, .content') || document.body);
  if (!root) return '';
  var hidden = (element) => { var style = getComputedStyle(element); return style.display === 'none' || style.visibility === 'hidden' || element.getAttribute('aria-hidden') === 'true'; };
  var absolute = (url) => { try { return new URL(url, location.href).href; } catch { return url; } };
  var clean = (text) => text.replace(/\\s+/g, ' ');
  function inline(node) {
    if (node.nodeType === 3) return clean(node.textContent);
    if (node.nodeType !== 1 || skip.test(node.tagName) || hidden(node)) return '';
    var inner = () => [...node.childNodes].map(inline).join('');
    switch (node.tagName) {
      case 'A': { var text = inner().trim(); var href = node.getAttribute('href'); return href && text && !href.startsWith('javascript:') ? '[' + text + '](' + absolute(href) + ')' : text; }
      case 'STRONG': case 'B': { var bold = inner().trim(); return bold ? '**' + bold + '** ' : ''; }
      case 'EM': case 'I': { var italic = inner().trim(); return italic ? '_' + italic + '_ ' : ''; }
      case 'CODE': return '\`' + node.textContent + '\`';
      case 'BR': return '\\n';
      case 'IMG': { var alt = node.getAttribute('alt'); return alt ? '![' + clean(alt) + '](' + absolute(node.getAttribute('src') || '') + ')' : ''; }
      default: return block(node) ? '\\n' + blocks(node) + '\\n' : inner();
    }
  }
  function block(node) { return /^(P|DIV|SECTION|ARTICLE|MAIN|UL|OL|LI|H[1-6]|PRE|BLOCKQUOTE|TABLE|FIGURE|FIGCAPTION|DL|DT|DD|HR|HEADER|FOOTER|NAV|ASIDE)$/.test(node.tagName); }
  function table(node) {
    var rows = [...node.querySelectorAll('tr')].map((row) => [...row.children].map((cell) => clean(inline(cell)).trim().replace(/\\|/g, '\\\\|')));
    if (!rows.length) return '';
    var width = Math.max(...rows.map((row) => row.length));
    var line = (row) => '| ' + Array.from({length: width}, (_, index) => row[index] || '').join(' | ') + ' |';
    return [line(rows[0]), '| ' + Array(width).fill('---').join(' | ') + ' |', ...rows.slice(1).map(line)].join('\\n');
  }
  function element(node, depth) {
    var tag = node.tagName;
    if (/^H[1-6]$/.test(tag)) return '#'.repeat(Number(tag[1])) + ' ' + clean(inline(node)).trim();
    if (tag === 'PRE') return '\`\`\`\\n' + node.textContent.replace(/\\n$/, '') + '\\n\`\`\`';
    if (tag === 'BLOCKQUOTE') return blocks(node, depth).split('\\n').map((line) => '> ' + line).join('\\n');
    if (tag === 'TABLE') return table(node);
    if (tag === 'HR') return '---';
    if (tag === 'UL' || tag === 'OL') return [...node.children].filter((child) => child.tagName === 'LI').map((item, index) =>
      '  '.repeat(depth) + (tag === 'OL' ? (index + 1) + '. ' : '- ') + blocks(item, depth + 1).trim()).join('\\n');
    return blocks(node, depth);
  }
  function blocks(node, depth = 0) {
    var parts = [], line = '';
    var flush = () => { if (line.trim()) parts.push(line.trim()); line = ''; };
    for (var child of node.childNodes) {
      if (child.nodeType === 1 && (skip.test(child.tagName) || hidden(child))) continue;
      if (child.nodeType === 1 && options.mainOnly !== false && child !== root && (chrome.test(child.tagName) || noise.test((child.id || '') + ' ' + (typeof child.className === 'string' ? child.className : '')))) continue;
      if (child.nodeType === 1 && block(child)) { flush(); var text = element(child, depth); if (text.trim()) parts.push(text.trim()); }
      else line += inline(child);
    }
    flush();
    return parts.join(depth ? '\\n' : '\\n\\n');
  }
  var title = options.title === false ? '' : '# ' + document.title.trim() + '\\n\\n';
  var markdown = (title + blocks(root)).replace(/\\n{3,}/g, '\\n\\n').trim();
  var max = options.max || 200000;
  return markdown.length > max ? markdown.slice(0, max) + '\\n\\n[truncated]' : markdown;
}

function __extendPageData(target, base) {
  var inspect = (fn, arg) => base.inspect('(' + fn.toString() + ')(' + JSON.stringify(arg ?? {}) + ')');
  return Object.assign(base, {
    // A request made by the page itself: its cookies, its origin, its CSRF token (csrf: true).
    request: (url, init = {}) => inspect(__pageRequest, typeof url === 'object' ? url : {...init, url}),
    // Re-sends a recorded request (page.network.list) from the page, with optional changes.
    replay: async (id, changes = {}) => {
      var entry = await __call({network: 'get', target, id});
      var headers = {};
      for (var [name, value] of Object.entries(entry.requestHeaders || {})) if (!__replayDropped.test(name)) headers[name] = value;
      var url = new URL(changes.url || entry.url);
      for (var [key, value] of Object.entries(changes.query || {})) url.searchParams.set(key, String(value));
      var request = {url: url.href, method: changes.method || entry.method, headers: {...headers, ...(changes.headers || {})}};
      if (changes.json !== undefined) {
        // No merge with the recording: an omitted field must not be silently replayed.
        request.json = changes.json;
      } else if (changes.body !== undefined) request.body = changes.body;
      return inspect(__pageRequest, request);
    },
    data: (options = {}) => base.inspect('(' + __readPageData.toString() + ')(' + __readMetadata.toString() + ', ' + JSON.stringify(options) + ')'),
    metadata: () => base.inspect('(' + __readMetadata.toString() + ')()'),
    markdown: (options = {}) => inspect(__readMarkdown, options),
    status: async () => {
      var status = await base.inspect(() => performance.getEntriesByType('navigation')[0]?.responseStatus ?? null);
      return status === null || status === undefined || status === '' ? null : Number(status);
    },
    // The page's session: every cookie (HttpOnly too) and its web storage.
    session: async (options = {}) => {
      var result = {url: await base.inspect(() => location.href)};
      if (options.cookies !== false) result.cookies = (await base.cdp('Network.getCookies', {urls: [result.url]})).cookies;
      if (options.storage !== false) Object.assign(result, await base.inspect(() => ({
        localStorage: Object.fromEntries(Object.entries(localStorage)),
        sessionStorage: Object.fromEntries(Object.entries(sessionStorage)),
      })));
      return result;
    },
  });
}

var __sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// Works through many URLs (or items with a url) in parallel tabs, reusing each tab. Retries
// failures, backs off when a site answers 429 or 503, and spaces requests to the same host.
async function __pool(items, worker, options = {}) {
  var concurrency = Math.min(Math.max(Number(options.concurrency ?? 4), 1), 10);
  var retries = Math.max(Number(options.retries ?? 2), 0);
  var spacing = Math.max(Number(options.perHostDelayMs ?? 0), 0);
  var queue = items.map((item, index) => ({item, index, attempts: 0}));
  var results = new Array(items.length), lastHit = new Map(), backoff = new Map();
  var urlOf = (item) => typeof item === 'string' ? item : item && item.url;
  async function wait(host) {
    var until = Math.max((lastHit.get(host) ?? 0) + spacing, backoff.get(host) ?? 0);
    lastHit.set(host, Math.max(Date.now(), until));
    if (until > Date.now()) await __sleep(until - Date.now());
  }
  // The runner's tab is stored on 'tab' as soon as it exists, so a failure never leaks it.
  async function attempt(job, tab) {
    var url = urlOf(job.item);
    if (url) {
      await wait(new URL(url).host);
      if (tab.page) await tab.page.goto(url);
      else tab.page = await browser.openTab(url, {new: true});
      var status = await tab.page.status().catch(() => null);
      if (status === 429 || status === 503) {
        var host = new URL(url).host;
        backoff.set(host, Date.now() + Math.min(60000, 2000 * 2 ** job.attempts));
        throw Object.assign(Error('HTTP ' + status + ' from ' + host), {retryable: true});
      }
    } else if (!tab.page) throw Error('Each item needs a url (or be one)');
    return worker(tab.page, job.item, job.index);
  }
  async function runner() {
    var tab = {};
    try {
      while (queue.length) {
        var job = queue.shift();
        try {
          results[job.index] = {ok: true, item: job.item, value: await attempt(job, tab)};
        } catch (error) {
          if (job.attempts++ < retries) { queue.push(job); continue; }
          results[job.index] = {ok: false, item: job.item, error: String(error && error.message || error)};
        }
        if (options.onProgress) options.onProgress(results.filter(Boolean).length, items.length);
      }
    } finally {
      if (tab.page && options.keepTabs !== true) await tab.page.close().catch(() => {});
    }
  }
  await Promise.all(Array.from({length: Math.min(concurrency, items.length)}, runner));
  return results;
}
`;
