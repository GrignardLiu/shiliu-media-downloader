const {test} = require('node:test');
const assert = require('node:assert/strict');
const {webcrypto} = require('node:crypto');
const {readFileSync} = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = name => readFileSync(path.join(__dirname, '../extension', name), 'utf8');
const base = 'https://media.test/';
const tabId = 11;
const doc = 'document-a';

function browser({legacyBrowser = false} = {}) {
  const events = {};
  const listener = name => ({addListener(fn) { events[name] = fn; }});
  const stored = {};
  const badges = new Map();
  const rules = new Map();
  const frames = new Map([[0, {frameId: 0, documentId: doc}]]);
  const mock = {
    scans: [], blockedChild: false,
    send(file, overrides = {}) {
      events.sent({url: base + file, frameId: 0, tabId, documentId: doc, method: 'GET',
        initiator: 'https://player.test', ...overrides});
    },
    capture(file, overrides = {}) {
      events.headers({url: base + file, frameId: 0, tabId, documentId: doc, method: 'GET',
        statusCode: 200, type: 'xmlhttprequest', ...overrides});
    },
    message(type, args = {}, sender = {url: 'chrome-extension://local/popup.html'}) {
      return new Promise(resolve => events.message({type, tabId, ...args}, sender, resolve));
    },
    list() { return this.message('LIST_MEDIA'); },
    dom(candidates) { this.scans = [{...frames.get(0), result: {hasBlob: false, candidates}}]; },
    events, stored, badges, frames, rules,
  };
  const chrome = {
    webRequest: {onHeadersReceived: listener('headers'), onSendHeaders: listener('sent'),
      onErrorOccurred: listener('requestError')},
    webNavigation: {
      onCommitted: listener('commit'), onHistoryStateUpdated: listener('history'),
      onReferenceFragmentUpdated: listener('hash'), getAllFrames: async () => {
        if (mock.frameBarrier) await mock.frameBarrier();
        return [...frames.values()];
      },
      getFrame: async ({tabId: requestedTab, frameId}) => requestedTab === tabId ? frames.get(frameId) || null : null,
    },
    tabs: {onRemoved: listener('closed'), create: async ({url}) => { mock.opened = url; },
      get: async id => mock.downloadFrames?.get(id) || null},
    runtime: {id: 'local', onInstalled: listener('installed'), onMessage: listener('message'),
      getURL: (p = '') => 'chrome-extension://local/' + p},
    declarativeNetRequest: {updateSessionRules: async ({removeRuleIds, addRules = []}) => {
      for (const id of removeRuleIds) rules.delete(id);
      for (const rule of addRules) rules.set(rule.id, rule);
    }},
    action: {setBadgeText: async ({tabId,text}) => badges.set(tabId,text)},
    storage: {session: {
      get: async key => structuredClone(key === null ? stored : {[key]: stored[key]}),
      set: async value => {
        if (mock.quota && Object.values({...stored, ...value}).filter(state => state.items?.length).length > mock.quota) {
          throw Error('QUOTA_BYTES quota exceeded');
        }
        Object.assign(stored, structuredClone(value));
      },
      remove: async key => { delete stored[key]; },
    }},
    scripting: {executeScript: async instruction => {
      const {target} = instruction;
      if (instruction.func) return mock.probe(instruction);
      if (target.allFrames && mock.blockedChild) throw Error('restricted frame');
      return mock.scans;
    }},
    downloads: {download: async options => { mock.download = options; return 37; }},
  };
  if (!legacyBrowser) chrome.runtime.getContexts = async ({tabIds, documentIds, contextTypes}) => {
    const frame = mock.downloadFrames?.get(tabIds[0]);
    return frame && contextTypes.includes('TAB') && documentIds.includes(frame.documentId) ? [frame] : [];
  };
  vm.runInNewContext(source('background.js'), {chrome, URL, URLSearchParams, crypto: webcrypto, TextEncoder, btoa,
    setTimeout, clearTimeout, console});
  return mock;
}

function headers(mime, more = {}) {
  return Object.entries({'Content-Type': mime, ...more}).map(([name,value]) => ({name, value}));
}
function candidate(file, from='element', kind='video') {
  return {url: base + file, from, kind, mime: '', time: 0};
}

test('only a readable original-document HLS GET can restore timing-only request context', async () => {
  const file = 'movie/master.m3u8?sig=keep%2Fexact';
  const owner = 'https://player.test';
  for (const scenario of ['success', 'no CORS', 'invalid body', 'old timing', 'two matching requests',
    'missing headers', 'credentials observed', 'navigation', 'timeout']) {
    const b = browser();
    b.frames.set(0, {frameId: 0, documentId: doc, url: owner + '/watch?private=hidden'});
    b.downloadFrames = new Map([[52, {documentId: 'download'}]]);
    b.dom([{...candidate(file, 'timing', ''), time: 101}]);
    const [master] = (await b.list()).items;
    let requests = 0;
    b.probe = async ({func, args, world, target}) => {
      assert.equal(world, 'ISOLATED');
      assert.deepEqual(structuredClone(target), {tabId, documentIds: [doc]});
      const fetch = async (url, options) => {
        requests++;
        assert.equal(url, base + file);
        assert.equal(options.credentials, 'omit');
        assert.equal(options.redirect, 'error');
        assert.equal(options.mode, 'cors');
        assert.equal(options.referrerPolicy, undefined);
        assert.equal(options.referrer, owner + '/');
        assert.deepEqual(Object.keys(options.headers), ['Accept']);
        const requestHeaders = headers('', {Accept: options.headers.Accept, Origin: owner, Referer: owner + '/'});
        if (scenario === 'credentials observed') requestHeaders.push({name: 'Cookie', value: 'private=1'});
        for (let i = 0; i < (scenario === 'two matching requests' ? 2 : 1); i++) {
          b.send(file, {requestId: 'probe'+i, type: 'xmlhttprequest', requestHeaders});
          b.capture(file, {requestId: 'probe'+i, responseHeaders: headers('application/vnd.apple.mpegurl'),
            statusCode: scenario === 'missing headers' ? 403 : 200});
        }
        if (scenario === 'no CORS') throw new TypeError('blocked');
        if (scenario === 'timeout') throw new DOMException('timeout', 'TimeoutError');
        if (scenario === 'navigation') b.frames.set(0, {frameId: 0, documentId: 'other', url: owner+'/other'});
        const bytes = new TextEncoder().encode(scenario === 'invalid body' ? '<html>not HLS' : '#EXTM3U\n#EXTINF:1,\n');
        return {url, status: 200, body: new ReadableStream({type: 'bytes',
          start(controller) { controller.enqueue(bytes); controller.close(); }})};
      };
      const result = await vm.runInNewContext('(' + func.toString() + ')(...args)', {
        args, fetch, location: {origin: owner}, AbortSignal, TextDecoder, Uint8Array,
        performance: {timeOrigin: 100, getEntriesByName: (url, type) => {
          assert.equal(url, base + file); assert.equal(type, 'resource');
          return [{initiatorType: 'fetch', responseStatus: 200, startTime: scenario === 'old timing' ? 2 : 1}];
        }},
      });
      return [{result, documentId: doc, frameId: 0}];
    };
    const sender = {url: 'chrome-extension://local/hls.html#tab=11&item='+master.id,
      frameId: 0, documentId: 'download', tab: {id: 52}};
    const result = await b.message('GET_MEDIA', {id: master.id}, sender);
    assert.equal(requests, scenario === 'old timing' ? 0 : 1, scenario);
    assert.equal(result.ok, scenario !== 'navigation', scenario);
    assert.equal(Boolean(b.rules.size), scenario === 'success', scenario);
    assert.equal(result.credentialOrigin, undefined);
    const record = b.stored['media:' + tabId].items[0];
    assert.equal(record.source, 'page', scenario);
    assert.equal(record.referrer, undefined, scenario);
    assert.equal(record.requestOrigin, undefined, scenario);
    assert.equal(record.hadCookies, undefined, scenario);
    if (b.rules.size) {
      const rule = [...b.rules.values()][0];
      assert.deepEqual(structuredClone(rule.action.requestHeaders).map(h => h.value), [owner+'/', owner]);
      assert.deepEqual(structuredClone(rule.condition.tabIds), [52]);
    }
  }
});

test('worker restart guard ignores only the exact outstanding probe and expires for a normal player', async () => {
  const b = browser();
  const file = 'playlist.m3u8?sig=unchanged';
  const scope = JSON.stringify([tabId, doc, base + file]);
  const digest = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(scope));
  const key = 'playlist-probe:' + Buffer.from(digest).toString('base64');
  const expiry = Date.now() + 3000;
  b.stored[key] = expiry;
  function capture(url, timeStamp) {
    const requestId = String(timeStamp);
    const requestHeaders = headers('', {Accept: 'application/vnd.apple.mpegurl, application/x-mpegurl;q=0.9, */*;q=0.5',
      Origin: 'https://player.test', Referer: 'https://player.test/'});
    b.send(url, {requestId, timeStamp, type: 'xmlhttprequest', requestHeaders});
    b.capture(url, {requestId, responseHeaders: headers('application/vnd.apple.mpegurl')});
  }
  capture(file, expiry - 20);
  assert.equal((await b.list()).items.length, 0);
  capture('another.m3u8', expiry - 10);
  assert.equal((await b.list()).items.length, 1);
  capture(file, expiry + 10);
  assert.equal((await b.list()).items.length, 2);
});

test('rendition-specific init and media segments do not compete with the HLS playlists', async () => {
  const b = browser();
  const init = 'vod/init-v1-a1.mp4?sig=example';
  const index = 'vod/index-v1-a1.m3u8?sig=example';
  const master = 'vod/master.m3u8?sig=example';
  b.capture(init, {type: 'media', responseHeaders: headers('video/mp4')});
  b.capture('vod/seg-43-v1-a1.mp4', {responseHeaders: headers('video/mp4')});
  b.capture('vod/opaque', {type: 'other', responseHeaders: headers('audio/mp4', {
    'Content-Disposition': 'inline; filename="init-a2.m4a"'
  })});
  b.capture(index, {responseHeaders: headers('application/vnd.apple.mpegurl')});
  b.capture(master, {responseHeaders: headers('application/vnd.apple.mpegurl')});
  for (const from of ['timing', 'link', 'element']) {
    b.dom([candidate(init, from)]);
    const {items} = await b.list();
    assert.deepEqual(Array.from(items, item => item.url).sort(), [base + index, base + master]);
    assert.equal(b.badges.get(tabId), '2');
  }
  b.capture('init-scene.mp4', {type: 'media', responseHeaders: headers('video/mp4')});
  b.capture('interview-v1-a1.mp4', {responseHeaders: headers('video/mp4')});
  b.capture('another/init-v1.mp4', {type: 'main_frame', responseHeaders: headers('video/mp4')});
  const {items} = await b.list();
  assert.deepEqual(Array.from(items, item => item.name).sort(), [
    'index-v1-a1.m3u8', 'init-scene.mp4', 'init-v1.mp4', 'interview-v1-a1.mp4', 'master.m3u8'
  ]);
});

test('discard cached initializer rows before an old popup can request a standalone download', async () => {
  const b = browser();
  const row = {frameId: 0, documentId: doc, source: 'network', rank: 2};
  b.stored['media:' + tabId] = {route: '', since: 0, items: [
    {...row, id: 'old-part', name: 'file.mp4', url: base + 'init%2Dv1-a1.mp4?sig=x', kind: 'video'},
    {...row, id: 'old-master', name: 'master.m3u8', url: base + 'master.m3u8', kind: 'hls'}
  ]};
  const result = await b.message('DOWNLOAD_MEDIA', {id: 'old-part'});
  assert.equal(result.ok, false);
  assert.equal(b.download, undefined);
  assert.equal(b.badges.get(tabId), '1');
  assert.deepEqual(Array.from((await b.list()).items, item => item.id), ['old-master']);
  assert.equal(b.stored['media:' + tabId].items.length, 1);
});

test('a verified master page offers only the most recent observed sibling variants from the same frame', async () => {
  const b = browser();
  const root = 'movie/master.m3u?token=master';
  const current = 'movie/index-v1-a1.m3u8?token=current';
  // Browser timing entries arrive newest first, regardless of catalogue insertion order.
  b.dom([{...candidate(root, 'timing'), time: 300}, {...candidate(current, 'timing'), time: 200},
    {...candidate('movie/index-v1-a1.m3u8?token=expired', 'timing'), time: 100},
    candidate('movie/720p.m3u8', 'link', '')]);
  b.frames.set(3, {frameId: 3, documentId: 'iframe'});
  b.capture('movie/480p.m3u8', {frameId: 3, documentId: 'iframe'});
  for (const file of ['movie/master.m3u8', 'movie/index-preroll.m3u8', 'movie/ads.m3u8',
    'another/index.m3u8', 'movie/ad/index.m3u8']) b.capture(file);
  b.capture('movie/360p.m3u8', {url: 'https://cdn2.test/movie/360p.m3u8'});
  const {items} = await b.list();
  const master = items.find(row => row.url === base + root);
  const variant = items.find(row => row.url === base + current);
  assert(!('playlistSeenAt' in master));
  b.stored['media:' + tabId].items.push({...variant, id: 'previous-doc', documentId: 'stale', frameId: 0,
    source: 'network', url: base + 'movie/1080p.m3u8', name: '1080p.m3u8'});
  b.downloadFrames = new Map([[50, {documentId: 'download'}]]);
  const senderFor = row => ({url: 'chrome-extension://local/hls.html#tab=11&item=' + row.id,
    frameId: 0, tab: {id: 50}, documentId: 'download'});
  const result = await b.message('GET_MEDIA', {id: master.id}, senderFor(master));
  assert.equal(result.ok, true);
  assert.deepEqual(structuredClone(result.alternatives), [{id: variant.id, name: variant.name}]);
  assert.equal((await b.message('GET_MEDIA', {id: master.id})).alternatives, undefined);
  assert.equal((await b.message('GET_MEDIA', {id: variant.id}, senderFor(variant))).alternatives, undefined);
  const closed = await b.message('GET_MEDIA', {id: master.id}, {...senderFor(master), documentId: 'gone'});
  assert.equal(closed.ok, false);
  assert.equal(closed.alternatives, undefined);
});

test('replayed signed playlist updates its observation time and the fallback list stays bounded', async () => {
  const b = browser();
  b.capture('vod/master.m3u8');
  for (let i = 1; i < 8; i++) b.capture('vod/index-v' + i + '.m3u8', {timeStamp: i});
  const chosen = 'vod/index-v8.m3u8?sig=replayed';
  b.capture(chosen, {timeStamp: 8});
  b.capture('vod/index-v8.m3u8?sig=earlier', {timeStamp: 9});
  b.capture(chosen, {timeStamp: 10});
  const {items} = await b.list();
  const master = items.find(row => row.name === 'master.m3u8');
  const sender = {url: 'chrome-extension://local/hls.html#tab=11&item=' + master.id,
    frameId: 0, tab: {id: 50}, documentId: 'download'};
  b.downloadFrames = new Map([[50, {documentId: 'download'}]]);
  const {alternatives} = await b.message('GET_MEDIA', {id: master.id}, sender);
  assert.equal(alternatives.length, 6);
  assert.equal(alternatives[0].id, items.find(row => row.url === base + chosen).id);
});

test('prefer declared format, preserve signed URL, filename, and full response size across ranges', async () => {
  const b = browser();
  const file = 'endpoint.mp3?signature=a%2Fb';
  b.capture(file, {statusCode: 206, responseHeaders: headers('audio/ogg', {
    'Content-Range': 'bytes 0-100/100000', 'Content-Disposition': "inline; filename*=UTF-8''%E6%B5%8B%E8%AF%95.mp3",
  })});
  b.capture(file, {statusCode: 206, responseHeaders: headers('application/octet-stream', {'Content-Length':'101'})});
  b.capture('signin.m3u8', {responseHeaders: headers('text/html; charset=UTF-8')});
  b.capture('cover.mp4', {responseHeaders: headers('image/jpeg')});
  b.capture('actually-video.m3u8', {responseHeaders: headers('video/mp4')});
  b.dom([candidate('spoken.webm', 'element', 'audio')]);
  const {items} = await b.list();
  const result = items.find(i => i.url === base + file);
  assert.equal(result.mime, 'audio/ogg');
  assert.equal(result.name, '测试.ogg');
  assert.equal(result.size, 100000);
  assert.equal(items.length, 3);
  assert.equal(items.find(i => i.name === 'spoken.webm').kind, 'audio');
  assert.equal(items.find(i => i.url.endsWith('.m3u8')).name, 'actually-video.mp4');
  assert.equal((await b.message('DOWNLOAD_MEDIA', {id: result.id})).downloadId, 37);
  assert.equal(b.download.url, base + file);
  assert.equal(b.download.filename, '测试.ogg');
});

test('restore only observed origins for the selected download tab and exact CDN origin', async () => {
  const b = browser();
  const file = 'film.mp4?signature=a%2Fb';
  const source = 'https://player.test';
  b.send(file, {requestId: 'good', requestHeaders: [
    {name: 'Referer', value: source + '/watch?private=page'}, {name: 'Origin', value: source},
    {name: 'Cookie', value: 'secret-session'}, {name: 'Authorization', value: 'secret-token'}
  ]});
  b.capture(file, {requestId: 'good', responseHeaders: headers('video/mp4')});
  const {items: [item]} = await b.list();
  assert(!JSON.stringify(b.stored).match(/private=page|secret-session|secret-token/));
  assert.equal(item.referrer, undefined);
  const {opened} = await b.message('DOWNLOAD_MEDIA', {id: item.id});
  assert.equal(opened, true);
  const sender = {url: b.opened, frameId: 0, documentId: 'download', tab: {id: 50}};
  b.downloadFrames = new Map([[50, {documentId: 'download'}]]);
  const result = await b.message('GET_MEDIA', {id: item.id}, sender);
  assert.equal(result.credentialOrigin, 'https://media.test');
  assert.equal(result.item.url, base + file);
  const rule = b.rules.get(51);
  assert.deepEqual(Array.from(rule.condition.tabIds), [50]);
  assert.deepEqual(Array.from(rule.condition.initiatorDomains), ['local']);
  assert.equal(rule.condition.urlFilter, '|https://media.test/');
  assert.deepEqual(Array.from(rule.action.requestHeaders, h => [h.header,h.value]),
    [['Referer',source+'/'], ['Origin',source]]);
  // Parallel exports do not share rules. Navigating one away cleans up only its rule.
  b.downloadFrames.set(51, {documentId: 'download2'});
  await b.message('GET_MEDIA', {id: item.id}, {...sender, tab: {id: 51}, documentId: 'download2'});
  assert.equal(b.rules.size, 2);
  b.events.commit({tabId: 50, frameId: 0, documentId: 'replacement', url: base+'elsewhere'});
  b.downloadFrames.set(50, {documentId: 'replacement'});
  assert.equal((await b.message('GET_MEDIA', {id: item.id}, sender)).ok, false);
  assert.equal(b.rules.has(51), false);
  assert.equal(b.rules.has(52), true);
  b.events.closed(51);
  await b.message('LIST_MEDIA', {tabId: 51});
  assert.equal(b.rules.size, 0);
});

test('ignore unsuccessful, redirected and unrelated request contexts and untrusted senders', async () => {
  const b = browser();
  const observed = {requestHeaders: [{name: 'Referer', value: 'https://player.test/watch'}]};
  b.send('bad.mp4', {requestId: 'bad', ...observed});
  b.capture('bad.mp4', {requestId: 'bad', statusCode: 403});
  b.send('redirect.mp4', {requestId: 'redirect', ...observed});
  b.capture('redirect.mp4', {requestId: 'redirect', statusCode: 302});
  b.capture('public.mp4', {requestId: 'redirect'});
  b.send('public.mp4', {requestId: 'other', requestHeaders: [
    {name: 'Referer', value: 'https://unrelated.test/private'}, {name: 'Origin', value: 'https://unrelated.test'}
  ]});
  b.capture('public.mp4', {requestId: 'other'});
  const {items: [item]} = await b.list();
  assert.equal(item.name, 'public.mp4');
  assert.equal((await b.message('DOWNLOAD_MEDIA', {id: item.id})).downloadId, 37);
  assert.equal(b.rules.size, 0);
  b.send('index.m3u8', {requestId: 'hls', ...observed});
  b.capture('index.m3u8', {requestId: 'hls', responseHeaders: headers('application/vnd.apple.mpegurl')});
  const stream = (await b.list()).items.find(row => row.kind === 'hls');
  const sender = {url: 'chrome-extension://local/hls.html#tab=11&item='+stream.id, frameId: 0,
    tab: {id: 50}, documentId: 'hls-page'};
  b.downloadFrames = new Map([[50, {documentId: 'hls-page'}]]);
  assert.equal((await b.message('GET_MEDIA', {id: stream.id}, {...sender, frameId: 1})).credentialOrigin, undefined);
  assert.equal(b.rules.size, 0);
  assert.equal((await b.message('GET_MEDIA', {id: stream.id}, sender)).ok, true);
  assert.equal(b.rules.size, 1);
});

test('older Chromium validates download tabs without webNavigation access to extension frames', async () => {
  const b = browser({legacyBrowser: true});
  b.send('old.mp4', {requestId: 'old', requestHeaders: [{name: 'Referer', value: 'https://player.test/watch'}]});
  b.capture('old.mp4', {requestId: 'old'});
  const {items: [item]} = await b.list();
  const sender = {url: 'chrome-extension://local/file.html#tab=11&item='+item.id, frameId: 0,
    documentId: 'old-page', tab: {id: 50}};
  b.downloadFrames = new Map([[50, {url: sender.url, pendingUrl: 'https://elsewhere.test/'}]]);
  assert.equal((await b.message('GET_MEDIA', {id: item.id}, sender)).ok, false);
  b.downloadFrames.set(50, {url: sender.url});
  assert.equal((await b.message('GET_MEDIA', {id: item.id}, sender)).ok, true);
  assert.equal(b.rules.size, 1);
});

test('catalogue cap retains network and current player IDs; restricted iframe falls back to main document', async () => {
  const b = browser();
  b.blockedChild = true;
  b.capture('opaque', {responseHeaders: headers('audio/mpeg')});
  const player = candidate('current.mp4');
  const links = Array.from({length: 160}, (_,i) => candidate(i+'.mp4', 'link', ''));
  b.dom([player, ...links]);
  const first = await b.list();
  assert.equal(first.scanBlocked, false);
  assert.equal(first.items.length, 120);
  assert(first.items.some(i => i.url === player.url));
  assert(first.items.some(i => i.url.endsWith('/opaque')));
  const second = await b.list();
  assert.deepEqual(second.items.map(i => i.id), first.items.map(i => i.id));
  b.dom([candidate('current-2.mp4')]);
  const refreshed = await b.list();
  assert.equal(refreshed.items.length, 2);
  assert(!refreshed.items.some(i => i.url === player.url));
});

test('ignore late responses from replaced documents, reject removed frames, reset on SPA hash routing', async () => {
  const b = browser();
  const nav = {tabId, frameId: 0, documentId: doc};
  b.events.commit({...nav, url: base + 'watch#/one'});
  b.capture('first.mp4');
  const first = (await b.list()).items[0];
  b.events.hash({...nav, url: base+'watch#/two', timeStamp: 200});
  assert.equal((await b.list()).items.length, 0);
  assert.equal((await b.message('GET_MEDIA', {id: first.id})).ok, false);
  b.frames.set(0, {frameId: 0, documentId: 'new-document'});
  b.events.commit({...nav, documentId: 'new-document', url: base + 'other'});
  b.capture('late.mp4');
  b.capture('current.mp4', {documentId: 'new-document'});
  const {items} = await b.list();
  assert.equal(items.length, 1);
  assert.equal(items[0].name, 'current.mp4');
  b.frames.delete(0);
  assert.equal((await b.message('DOWNLOAD_MEDIA', {id: items[0].id})).ok, false);
  assert.equal(b.download, undefined);
});

test('shared session quota recovers by releasing only older media caches', async () => {
  const b = browser();
  b.quota = 1;
  b.stored['media:7'] = {items: [{url: base+'old.mp4'}], updatedAt: 1};
  b.stored.settings = {language: 'zh-CN'};
  b.capture('new.mp4');
  const [item] = (await b.list()).items;
  assert.equal(item.name, 'new.mp4');
  assert.equal(b.stored['media:7'], undefined);
  assert.equal(b.badges.get(7), '');
  assert.deepEqual(b.stored.settings, {language: 'zh-CN'});
});

test('a scan finishing after a route event cannot repopulate the next route with its old snapshot', async () => {
  const b = browser();
  b.dom([candidate('previous.mp4')]);
  let started, release;
  const scanning = new Promise(resolve => { started = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  b.frameBarrier = () => { started(); return barrier; };
  const list = b.list();
  await scanning;
  b.events.history({tabId, frameId: 0, documentId: doc, url: base+'next', timeStamp: 200});
  release();
  const old = (await list).items[0];
  assert.equal(old.name, 'previous.mp4');
  assert.equal((await b.message('GET_MEDIA', {id: old.id})).ok, false);
});

test('scan open shadow players and prefer observed MIME over a misleading player URL when exposed', async () => {
  const player = {localName: 'audio', currentSrc: '', getAttribute: () => 'sound.webm', querySelectorAll: () => []};
  const login = {...player, localName: 'video', getAttribute: () => 'login.mp4'};
  const shadow = {querySelectorAll: s => s === 'video, audio' ? [player, login] : []};
  const document = {baseURI: base, querySelectorAll: s => s === '*' ? [{shadowRoot: shadow}] : []};
  const timing = {initiatorType: 'fetch', contentType: 'audio/mpeg', startTime: 10};
  const performance = {timeOrigin: 100, getEntriesByType: () => [
    {...timing, name: base+'opaque', responseStatus: 200},
    {...timing, name: base+'gone.mp3', responseStatus: 404},
    {...timing, name: base+'login.mp4', contentType: 'text/html', responseStatus: 200},
  ]};
  const {candidates} = vm.runInNewContext(source('content.js'), {document, performance, URL});
  assert.equal(candidates.length, 3);
  assert.equal(candidates[0].kind, 'audio');
  assert.equal(candidates.find(c => c.url === base+'opaque').time, 110);
  const b = browser();
  b.dom([candidate('login.mp4')]);
  assert.equal((await b.list()).items.length, 1);
  b.dom(candidates);
  const {items} = await b.list();
  assert.equal(items.length, 2);
  assert(!items.some(i => i.url.endsWith('login.mp4')));
});
