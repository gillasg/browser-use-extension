// Sites in browser code: site skills (helpers saved per site), mapped site APIs, and learning
// a site's API while the agent works in it. Evaluated in the code sandbox with the other APIs.
export const browserSitesApi = `
var __skillCache = new Map();
async function __siteSkills(url) {
  var host; try { host = new URL(url).hostname; } catch { return []; }
  var cached = __skillCache.get(host);
  if (cached && Date.now() - cached.at < 60000) return cached.list;
  var list = await __call({siteSkill:'list', url}).catch(() => []);
  __skillCache.set(host, {at: Date.now(), list});
  return list;
}
// Skills on the current site load by themselves, once per chat (again after one is saved), so
// their helpers are defined without the agent having to remember skills.load.
var __loadedSkills = new Map();
async function __autoLoadSkills(url) {
  var known = await __siteSkills(url);
  var lines = [];
  for (var item of known.slice(0, 4)) {
    if (__loadedSkills.has(item.name)) continue;
    try {
      var info = await skills.load(item.name);
      lines.push(item.name + (info.defines.length ? ' (defines ' + info.defines.join(', ') + ')' : '') + ' - ' + item.description.slice(0, 80));
    } catch (error) {
      __loadedSkills.set(item.name, []);
      lines.push(item.name + ' failed to load: ' + String(error && error.message || error).slice(0, 120));
    }
  }
  return lines.length ? 'Site skills loaded: ' + lines.join('; ') : '';
}
var skills = Object.freeze({
  list: (url) => __call({siteSkill:'list', url: url ?? (__lastTarget ? browser.page(__lastTarget).url : undefined)}),
  load: async (name) => {
    var skill = await __call({siteSkill:'get', name});
    var before = new Set(Object.keys(globalThis));
    // Same rules as a cell: top-level const/let/function persist. A skill whose code returns an
    // object (the function form) has its function members defined as globals.
    var value = await (0, eval)(__repl(skill.code));
    if (value && typeof value === 'object')
      for (var [key, member] of Object.entries(value)) if (typeof member === 'function') globalThis[key] = member;
    var defines = Object.keys(globalThis).filter(key => !before.has(key) && typeof globalThis[key] === 'function');
    __loadedSkills.set(skill.name, defines);
    return {name: skill.name, domains: skill.domains, description: skill.description, examples: skill.examples, defines};
  },
  save: async (skill) => {
    // The function form: its body runs on load, and the object it returns becomes globals.
    var code = typeof skill.code === 'function' ? 'return await (' + skill.code.toString() + ')()' : skill.code;
    var saved = await __call({siteSkill:'save', skill: {...skill, code}});
    __skillCache.clear();
    __loadedSkills.delete(saved.saved);
    return saved;
  },
  remove: async (name) => { __skillCache.clear(); __loadedSkills.delete(name); return __call({siteSkill:'delete', name}); },
});
// Mapped site APIs (site-to-api): call an operation, or watch it for items new or changed since the last watch.
// write repeats a routine write the page has proven; batch runs one over many items, paced.
var siteApi=Object.freeze({
  sites:()=>__call({siteApi:'sites'}),
  operations:site=>__call({siteApi:'operations',site}),
  call:(site,operation,params={})=>__call({siteApi:'call',site,operation,params}),
  write:(site,operation,params={})=>__call({siteApi:'write',site,operation,params}),
  batch:(site,operation,items,options={})=>__writeBatch(site,operation,items,options),
  watch:(site,operation,params={},options={})=>__call({siteApi:'watch',site,operation,params,...options}),
  action:(site,name,inputs={})=>__call({siteApi:'action',site,name,params:inputs}),
  channel:(site,id,options={})=>__call({siteApi:'channel',site,name:id,params:options}),
});
// The here: line at the top of bu.state(): what already exists for this page and site (its
// embedded data, the API the site learned, its boosts), printed only when it changes, so the
// agent reaches for them without being told twice.
var __hereShown = new Map(), __siteFacts = new Map();
async function __here(target, url) {
  var host; try { host = new URL(String(url)).hostname.replace(/^www\\./, ''); } catch { return ''; }
  var parts = [], data = await __fastProbe(target, url);
  if (data) parts.push(data);
  var facts = __siteFacts.get(host);
  if (!facts || Date.now() - facts.at > 60000) {
    var operations = await __call({siteApi: 'operations', site: host}).catch(() => []);
    var boosts = await browser.boosts.list(String(url)).catch(() => []);
    facts = {at: Date.now(), operations: Array.isArray(operations) ? operations : [], boosts: Array.isArray(boosts) ? boosts : []};
    __siteFacts.set(host, facts);
  }
  if (facts.operations.length) {
    var reads = facts.operations.filter(op => !op.writes).map(op => op.id), writes = facts.operations.filter(op => op.writes).map(op => op.id);
    parts.push('site API (siteApi.call): ' + reads.slice(0, 6).join(', ') + (reads.length > 6 ? ' +' + (reads.length - 6) : '') + (writes.length ? ' · writes: ' + writes.slice(0, 4).join(', ') : ''));
  }
  if (facts.boosts.length) parts.push('boosts: ' + facts.boosts.slice(0, 3).map(b => b.name).join(', '));
  var text = parts.length ? 'here: ' + parts.join(' · ') : '';
  if (!text || __hereShown.get(host) === text) return '';
  __hereShown.set(host, text);
  return text;
}
// Learning a site's API while working. Every tab the agent acts in records the site's own
// requests (passively: no trackers, no cookies, no passwords); after each cell they are tagged
// with the page step that sent them and built into the site's API at once (no model). New
// operations are announced once per chat, in the cell's output.
var __learning = new Set(), __actions = [], __announced = new Set(), __learnTouched = new Map(), __handedOff = false;
async function __learnOn(target, step) {
  var key = __key(target);
  __learnTouched.set(key, target);
  if (step) {
    __actions.push({at: Date.now(), key, label: __stepLabel(step)});
    if (__actions.length > 60) __actions.shift();
  }
  if (__learning.has(key)) return;
  __learning.add(key);
  await __call({network: 'learn-start', target}).catch(() => {});
}
// 'click "Remove from Watch later"', 'fill "Search"', 'press Enter', 'open https://…'.
function __stepLabel(step) {
  var element = step.element || {}, name;
  if (element.kind === 'backend' || element.kind === 'ref') {
    var state = __states.get(__key(step.target));
    var node = state && state.nodes.find(n => n.backendNodeId === element.backendNodeId || (element.ref && n.ref === element.ref));
    name = node && node.name;
  } else name = element.name || element.value || element.text;
  if (step.op === 'navigate') return 'open ' + String(step.url || '').slice(0, 120);
  var quoted = name ? ' "' + String(name).replace(/"/g, "'").slice(0, 60) + '"' : '';
  if (step.op === 'keys' || step.op === 'press') return 'press ' + (step.keys || step.key || '') + (quoted ? ' in' + quoted : '');
  return step.op + quoted;
}
async function __learnFromCell() {
  var lines = [], approved = __handedOff;
  __handedOff = false;
  for (var target of [...__learnTouched.values()]) {
    try {
      var har = await __call({network: 'take', target});
      var entries = (har && har.log && har.log.entries) || [];
      if (!entries.length) continue;
      var key = __key(target);
      for (var entry of entries) {
        var at = Date.parse(entry.startedDateTime);
        var cause = __actions.filter(a => a.key === key && a.at <= at + 50 && at - a.at < 15000).pop();
        if (cause) entry._step = cause.label;
      }
      var url = (__tabs.get(key) && __tabs.get(key).url) || entries[0].request.url;
      var result = await __call({siteApi: 'learn-live', site: new URL(String(url)).hostname, har, approved});
      for (var op of (result && result.learned) || []) {
        var seen = result.site + '|' + op.id + '|' + (op.proven ? 'proven' : '');
        if (__announced.has(seen)) continue;
        __announced.add(seen);
        lines.push(__learnedLine(result.site, op));
        __siteFacts.delete(result.site);
      }
    } catch {}
  }
  __learnTouched.clear();
  if (!lines.length) return;
  var shown = lines.slice(0, 3);
  if (lines.length > 3) shown.push('(+' + (lines.length - 3) + ' more: siteApi.operations(site))');
  console.log(shown.join('\\n'));
}
function __learnedLine(site, op) {
  var what = op.role === 'read' ? 'read' : op.proven ? 'write, proven by ' + (op.step || 'the page') : op.kind === 'consequential' ? 'write that stays in the page' : 'write';
  var text = 'Learned on ' + site + ': ' + op.id + ' (' + what + '). ' + op.how;
  if (op.varies && op.varies.length) text += '. Per item: ' + op.varies.join('; ');
  return text;
}
// One write over many items: paced (3 a second unless told), the first checked with
// options.verify(result, item) when given, stopping at the first error or rate limit. What is
// left continues in the page, and that run repairs the operation.
async function __writeBatch(site, operation, items, options = {}) {
  if (!Array.isArray(items)) throw Error('siteApi.batch(site, operation, items): items is an array of params objects');
  var gap = 1000 / Math.max(0.2, Math.min(10, Number(options.perSecond) || 3));
  var label = options.label || operation, results = [], stopped;
  bu.progress(0, items.length, label);
  for (var index = 0; index < items.length; index++) {
    var started = Date.now();
    try {
      var value = await siteApi.write(site, operation, items[index]);
      if (index === 0 && typeof options.verify === 'function' && !(await options.verify(value, items[0])))
        throw Error('the first write did not do what the page does (verify returned false)');
      results.push({ok: true});
    } catch (error) {
      stopped = {index, item: items[index], error: String(error && error.message || error).slice(0, 300)};
      break;
    }
    bu.progress(index + 1, items.length, label);
    var wait = gap - (Date.now() - started);
    if (wait > 0 && index < items.length - 1) await new Promise(resolve => setTimeout(resolve, wait));
  }
  var done = results.length, remaining = items.slice(done);
  console.log('[batch] ' + operation + ': ' + done + '/' + items.length + ' done' + (stopped ? '; stopped at item ' + (stopped.index + 1) + ': ' + stopped.error + '. Do the remaining ' + remaining.length + ' in the page; that repairs the operation.' : ''));
  return {done, total: items.length, ...(stopped ? {stopped, remaining} : {})};
}
`;
