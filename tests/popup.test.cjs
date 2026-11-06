const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = name => readFileSync(path.join(__dirname, '../extension', name), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

// Only the DOM methods used by the popup are needed for testing asynchronous browser events.
class Element {
  children = [];
  dataset = {};
  attributes = {};
  handlers = {};
  nodes = new Map();
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; }
  querySelector(key) {
    if (!this.nodes.has(key)) this.nodes.set(key, new Element());
    return this.nodes.get(key);
  }
  querySelectorAll() { return this.children; }
  addEventListener(key, fn) { this.handlers[key] = fn; }
  replaceChildren(...children) { this.children = children; }
  cloneNode() { return new Element(); }
  closest() { return this; }
}

async function popup() {
  const elements = Object.fromEntries([...source('popup.html').matchAll(/ id="([^"]+)"/g)]
    .map(([, id]) => [id, new Element()]));
  const items = ['audio', 'hls'].map(kind => ({
    id: kind, kind, url: 'https://cdn.example.test/' + kind + '?token=secret', name: kind,
  }));
  elements['row-template'].content = {firstElementChild: new Element()};
  elements.filters.children = ['all', 'audio', 'stream'].map(filter => {
    const button = new Element();
    button.dataset.filter = filter;
    return button;
  });
  const api = {
    item: {state: 'in_progress'},
    response: {ok: true, downloadId: 12},
    opened: [],
    ids: [],
    action(i) { return elements.list.children[i].querySelector('.action'); },
    note(i) { return elements.list.children[i].querySelector('.transfer-status'); },
    filter(i) { elements.filters.handlers.click({target: elements.filters.children[i]}); },
  };
  const chrome = {
    runtime: {getURL: n => 'chrome-extension://test/' + n, sendMessage: async msg =>
      msg.type === 'LIST_MEDIA' ? {ok: true, items} : api.response},
    tabs: {query: async () => [{id: 7, url: 'https://example.test/watch'}], create: async tab => api.opened.push(tab.url)},
    downloads: {
      search: async ({id}) => { api.ids.push(id); return [api.item]; },
      onChanged: {addListener(fn) { api.changed = fn; }},
    },
  };
  vm.runInNewContext(source('popup.js'), {
    chrome, document: {getElementById: id => elements[id]}, URL, URLSearchParams,
  });
  await tick();
  return api;
}

test('an accepted download reports its real late failure on the same row, including after a filter change', async () => {
  const ui = await popup();
  const starting = ui.action(0).handlers.click();
  assert.match(ui.note(0).textContent, /准备/);
  await starting;
  assert.equal(ui.action(0).disabled, true);
  assert.match(ui.note(0).textContent, /正在下载/);
  ui.filter(2);
  ui.item = {state: 'interrupted', error: 'SERVER_FORBIDDEN'};
  ui.changed({id: 99, state: {current: 'interrupted'}});
  ui.changed({id: 12, state: {current: 'interrupted'}});
  await tick();
  ui.filter(0);
  assert.deepEqual(ui.ids, [12, 12]);
  assert.match(ui.note(0).textContent, /网站拒绝/);
  assert.equal(ui.note(0).dataset.tone, 'error');
  assert.equal(ui.action(0).disabled, false);
});

test('completion before the ID arrives is read back, with a sign-in page reported separately from valid media', async () => {
  const ui = await popup();
  ui.item = {state: 'complete', mime: 'audio/mpeg'};
  await ui.action(0).handlers.click();
  assert.match(ui.note(0).textContent, /已下载/);
  ui.item = {state: 'complete', mime: 'text/html; charset=utf-8'};
  await ui.action(0).handlers.click();
  assert.match(ui.note(0).textContent, /网页/);
  assert.equal(ui.note(0).dataset.tone, 'error');
});

test('direct and HLS file pages show where to continue without registering native downloads', async () => {
  const ui = await popup();
  ui.response = {ok: true, opened: true};
  await ui.action(0).handlers.click();
  assert.match(ui.note(0).textContent, /已打开下载页/);
  await ui.action(1).handlers.click();
  assert.deepEqual(ui.opened, ['chrome-extension://test/hls.html#tab=7&item=hls']);
  assert.match(ui.note(1).textContent, /HLS/);
  assert.deepEqual(ui.ids, []);
});

test('current failed response suppresses stale player sources and links, and a later successful response restores them', () => {
  const base = 'https://example.test/';
  const url = base + 'track.mp4?q=signed%2Fvalue';
  const link = {getAttribute: () => url + '#fragment', type: 'video/mp4'};
  const player = {localName: 'video', currentSrc: url, getAttribute: () => url, querySelectorAll: () => []};
  const document = {baseURI: base, querySelectorAll: selector =>
    selector === 'a[href]' ? [link] : selector === 'video, audio' ? [player] : []};
  const events = [200, 403].map((responseStatus, startTime) => ({
    name: url, responseStatus, startTime, contentType: 'video/mp4', initiatorType: 'video',
  }));
  const performance = {timeOrigin: 100, getEntriesByType: () => events};
  const scan = () => vm.runInNewContext(source('content.js'), {URL, document, performance}).candidates;
  assert.equal(scan().length, 0);
  events.push({...events[0], startTime: 3});
  assert.equal(scan().length, 1);
  assert.equal(scan()[0].url, url);
  assert.equal(scan()[0].kind, 'video');
});

test('a player pointing to its HTML document is skipped while a direct media document stays downloadable', () => {
  const url = 'https://example.test/watch';
  const player = {localName: 'video', currentSrc: url + '#', getAttribute: () => '#', querySelectorAll: () => []};
  const document = {URL: url, baseURI: url, contentType: 'text/html',
    querySelectorAll: selector => selector === 'video, audio' ? [player] : []};
  const performance = {getEntriesByType: () => []};
  const scan = () => vm.runInNewContext(source('content.js'), {URL, document, performance}).candidates;
  assert.equal(scan().length, 0);
  document.contentType = 'video/mp4';
  assert.equal(scan()[0].url, url);
});
