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

function browser() {
  const events = {};
  const listener = name => ({addListener(fn) { events[name] = fn; }});
  const stored = {};
  const badges = new Map();
  const frames = new Map([[0, {frameId: 0, documentId: doc}]]);
  const mock = {
    scans: [], blockedChild: false,
    capture(file, overrides = {}) {
      events.headers({url: base + file, frameId: 0, tabId, documentId: doc, method: 'GET',
        statusCode: 200, type: 'xmlhttprequest', ...overrides});
    },
    message(type, args = {}) {
      const sender = {url: 'chrome-extension://local/popup.html'};
      return new Promise(resolve => events.message({type, tabId, ...args}, sender, resolve));
    },
    list() { return this.message('LIST_MEDIA'); },
    dom(candidates) { this.scans = [{...frames.get(0), result: {hasBlob: false, candidates}}]; },
    events, stored, badges, frames,
  };
  const chrome = {
    webRequest: {onHeadersReceived: listener('headers')},
    webNavigation: {
      onCommitted: listener('commit'), onHistoryStateUpdated: listener('history'),
      onReferenceFragmentUpdated: listener('hash'), getAllFrames: async () => {
        if (mock.frameBarrier) await mock.frameBarrier();
        return [...frames.values()];
      },
      getFrame: async ({frameId}) => frames.get(frameId) || null,
    },
    tabs: {onRemoved: listener('closed')},
    runtime: {onInstalled: listener('installed'), onMessage: listener('message'), getURL: () => 'chrome-extension://local/'},
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
  vm.runInNewContext(source('background.js'), {chrome, URL, crypto: webcrypto, TextEncoder, btoa, console});
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
