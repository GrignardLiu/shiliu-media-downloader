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
    scripting: {executeScript: async ({target}) => {
      if (target.allFrames && mock.blockedChild) throw Error('restricted frame');
      return mock.scans;
    }},
    downloads: {download: async options => { mock.download = options; return 37; }},
  };
  if (!legacyBrowser) chrome.runtime.getContexts = async ({tabIds, documentIds, contextTypes}) => {
    const frame = mock.downloadFrames?.get(tabIds[0]);
    return frame && contextTypes.includes('TAB') && documentIds.includes(frame.documentId) ? [frame] : [];
  };
  vm.runInNewContext(source('background.js'), {chrome, URL, URLSearchParams, crypto: webcrypto, TextEncoder, btoa, console});
  return mock;
}

function headers(mime, more = {}) {
  return Object.entries({'Content-Type': mime, ...more}).map(([name,value]) => ({name, value}));
}
function candidate(file, from='element', kind='video') {
  return {url: base + file, from, kind, mime: '', time: 0};
}

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
