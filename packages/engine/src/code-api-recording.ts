// Streaming DevTools events and recording a tab, for browser_code: page.onCdp(event, handler)
// calls the handler for every matching DevTools event until stopped, and page.recordTab(options)
// saves the tab's screencast as JPEG frames plus frames.json (one wall-clock time per frame, the
// same clock as the timings actions return) in the workspace. Evaluated in the sandbox realm.
export const browserRecordingApi = `
function __cdpStream(target, event, handler, options = {}) {
  var stopped = false, id, failure;
  var ready = __call({op:'event',target,action:'subscribe',event}).then((result) => (id = result.data.subscriptionId));
  var loop = (async () => {
    await ready;
    while (!stopped) {
      try {
        var result = await __call({op:'event',target,action:'poll',subscriptionId:id,timeoutMs:1000});
        if (result.data.dropped && options.onDropped) options.onDropped(result.data.dropped);
        for (var item of result.data.events) await handler(item.params, item.at);
      } catch (error) { failure = error; stopped = true; }
    }
    await __call({op:'event',target,action:'dispose',subscriptionId:id}).catch(() => {});
    if (failure && !/disposed/.test(String(failure.message))) throw failure;
  })();
  return Object.freeze({ready, stop: async () => { stopped = true; await loop.catch(() => {}); }, done: loop});
}

async function __recordTab(target, options = {}) {
  var page = browser.page(target);
  var name = String(options.name || 'recording-' + Date.now()).replace(/[^A-Za-z0-9._-]+/g, '-');
  var frames = [], writes = [], every = Math.max(1, Math.round(60 / Math.min(60, options.fps ?? 30)));
  var stream = __cdpStream(target, 'Page.screencastFrame', (params) => {
    var file = name + '/frame-' + String(frames.length + 1).padStart(6, '0') + '.jpg';
    var meta = params.metadata || {};
    frames.push({file, t: Math.round((meta.timestamp || Date.now() / 1000) * 1000), width: meta.deviceWidth, height: meta.deviceHeight, scrollX: meta.scrollOffsetX, scrollY: meta.scrollOffsetY});
    writes.push(__call({workspace:'artifact', name: file, value: params.data, base64: true}));
  });
  await stream.ready;
  await page.cdp('Page.startScreencast', {format: 'jpeg', quality: options.quality ?? 85, maxWidth: options.maxWidth ?? 1920, maxHeight: options.maxHeight ?? 1080, everyNthFrame: every});
  var startedAt = Date.now();
  var stop = async () => {
    await page.cdp('Page.stopScreencast', {}).catch(() => {});
    await stream.stop();
    await Promise.all(writes);
    var summary = {folder: name, frames: frames.length, startedAt, stoppedAt: Date.now(),
      fps: frames.length > 1 ? Math.round((frames.length - 1) / ((frames[frames.length - 1].t - frames[0].t) / 1000) * 10) / 10 : 0};
    await __call({workspace:'artifact', name: name + '/frames.json', value: JSON.stringify({...summary, frames}, null, 1)});
    if (!frames.length) summary.warning = 'No frames: Chrome only paints visible windows. Open the tab with browser.openTab(url, {window: {width, height}}) and keep it unminimized.';
    return summary;
  };
  if (options.seconds) { await __sleep(Math.min(options.seconds, 50) * 1000); return stop(); }
  return Object.freeze({folder: name, stop, frames: () => frames.length});
}
`;
