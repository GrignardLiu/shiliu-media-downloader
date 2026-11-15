/* MAIN-world observer: only inspect JSON responses the page already requested. */
(() => {
  'use strict';
  const parser = globalThis.ShiliuPageMedia;
  if (!parser?.extractJson || !globalThis.document || globalThis.__shiliuPageObserverV1) return;
  const host = location.hostname;
  if (!/(^|\.)(douyin\.com|iesdouyin\.com)$/.test(host) || !['http:', 'https:'].includes(location.protocol)) return;
  Object.defineProperty(globalThis, '__shiliuPageObserverV1', {value:true, configurable:false});
  const extractJson = parser.extractJson;
  const MAX_RESPONSE = 2 * 1024 ** 2, MAX_ACTIVE = 2, MAX_CANDIDATES = 400;
  const MAX_CACHE_CHARS = 240 * 1024, MAX_BRIDGE_CHARS = 256 * 1024, MAX_IDENTITIES = 4096;
  const NODE_ID = 'shiliu-observed-media';
  const API_PATH = /^\/aweme\/v\d+\/(?:web\/)?(?:aweme\/(?:detail|post|favorite|related|feed)|(?:(?:tab|channel|recommend|module)\/)?feed|mix\/aweme|long\/aweme|search\/item|general\/search\/(?:single|stream))\/?$/;
  const cache = new Map(), identities = new Map();
  let route = location.href, generation = 0, active = 0, cacheChars = 0, pendingDom, bridgeNode;
  function currentRoute() {
    const next = location.href;
    if (next !== route) { route = next; generation++; cache.clear(); identities.clear(); cacheChars = 0; publish(); }
    return route;
  }
  function eligible(raw) {
    try {
      const url = new URL(raw, location.href);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password &&
        /(^|\.)(douyin\.com|iesdouyin\.com)$/.test(url.hostname) && API_PATH.test(url.pathname) ? url.href : '';
    } catch { return ''; }
  }
  // Compact conservative identity tombstones survive candidate LRU eviction.
  // A hash collision can only suppress a candidate; it never creates a match.
  function key(url) {
    let a = 0x811c9dc5, b = 0x9e3779b9;
    for (let index = 0; index < url.length; index++) { const value = url.charCodeAt(index); a = Math.imul(a ^ value, 0x01000193); b = Math.imul(b ^ value, 0x85ebca6b); }
    return (a >>> 0).toString(16) + ':' + (b >>> 0).toString(16);
  }
  function remove(url) { const old = cache.get(url); if (old) { cacheChars -= old.chars; cache.delete(url); } }
  function safeCandidate(input, observedAt) {
    if (!input || typeof input.url !== 'string' || input.url.length > 16384 || !['video','audio'].includes(input.kind) ||
        typeof input.awemeId !== 'string' || !/^[A-Za-z0-9_.-]{3,120}$/.test(input.awemeId)) return null;
    try { const url = new URL(input.url); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null; } catch { return null; }
    const result = {url:input.url, kind:input.kind, awemeId:input.awemeId, contentId:input.awemeId,
      pairId:'dy-aweme-' + input.awemeId, source:'page-json', evidence:'douyin-video-object', observedAt};
    for (const field of ['mime','codec','quality','audioGroup','trackId']) if (typeof input[field] === 'string' && input[field].length <= 320) result[field] = input[field];
    if (typeof input.bitrate === 'number' && Number.isFinite(input.bitrate) && input.bitrate > 0) result.bitrate = input.bitrate;
    return result;
  }
  function accept(value, started) {
    currentRoute();
    if (started.generation !== generation || started.pageUrl !== route) return;
    const rows = extractJson(value, {pageUrl:started.pageUrl});
    if (!Array.isArray(rows)) return;
    for (const input of rows.slice(0, MAX_CANDIDATES)) {
      const candidate = safeCandidate(input, started.observedAt); if (!candidate) continue;
      const digest = key(candidate.url), owner = candidate.awemeId + ':' + candidate.kind, known = identities.get(digest);
      if (known && known !== owner) {
        identities.set(digest, '!conflict');
        for (const [url] of cache) if (key(url) === digest) remove(url);
        continue;
      }
      if (!known) { if (identities.size >= MAX_IDENTITIES) continue; identities.set(digest, owner); }
      remove(candidate.url);
      const chars = JSON.stringify(candidate).length + 1;
      while (cache.size && (cache.size >= MAX_CANDIDATES || cacheChars + chars > MAX_CACHE_CHARS)) remove(cache.keys().next().value);
      if (chars <= MAX_CACHE_CHARS) { cache.set(candidate.url, {candidate, chars}); cacheChars += chars; }
    }
    publish();
  }
  function publish() {
    const parent = document.head || document.documentElement;
    if (!parent) {
      if (!pendingDom && typeof MutationObserver === 'function') {
        pendingDom = new MutationObserver(() => { if (document.head || document.documentElement) { pendingDom.disconnect(); pendingDom = null; publish(); } });
        pendingDom.observe(document, {childList:true, subtree:true});
      }
      return;
    }
    const value = {version:1, pageUrl:route, observedAt:Date.now(), candidates:[...cache.values()].map(entry => entry.candidate)};
    let text = JSON.stringify(value);
    while (text.length > MAX_BRIDGE_CHARS && cache.size) { remove(cache.keys().next().value); value.candidates = [...cache.values()].map(entry => entry.candidate); text = JSON.stringify(value); }
    if (text.length > MAX_BRIDGE_CHARS) return;
    let node = bridgeNode?.isConnected ? bridgeNode : document.getElementById(NODE_ID);
    if (!node || node.tagName !== 'SCRIPT') {
      node = document.createElement('script'); node.id = NODE_ID; node.type = 'application/json'; parent.appendChild(node);
    }
    bridgeNode = node; node.type = 'application/json'; node.textContent = text;
  }
  function begin() { const pageUrl = currentRoute(); return {pageUrl, generation, observedAt:Date.now()}; }
  function boundedText(text) {
    if (typeof text !== 'string' || text.length > MAX_RESPONSE) return false;
    let bytes = 0;
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      bytes += code < 128 ? 1 : code < 2048 ? 2 : code >= 0xd800 && code <= 0xdbff && index + 1 < text.length && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff ? (index++, 4) : 3;
      if (bytes > MAX_RESPONSE) return false;
    }
    return true;
  }
  function jsonType(value) { return /^(?:application|text)\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|\s*$)/i.test(value || ''); }
  async function readBounded(response) {
    const clone = response.clone();
    if (!clone.body) return null;
    const reader = clone.body.getReader(), parts = []; let size = 0, expired = false;
    const timer = setTimeout(() => { expired = true; reader.cancel().catch(() => {}); }, 3000);
    try {
      for (;;) {
        const {value, done} = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE) { reader.cancel().catch(() => {}); return null; }
        parts.push(value);
      }
      if (!size || expired) return null;
      const bytes = new Uint8Array(size); let offset = 0;
      for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
      return JSON.parse(new TextDecoder().decode(bytes));
    } finally { clearTimeout(timer); try { reader.releaseLock(); } catch {} }
  }
  function observeFetch(response, requestUrl, started) {
    try {
      if (!requestUrl || active >= MAX_ACTIVE || response.status < 200 || response.status >= 300 ||
          !eligible(response.url || requestUrl) || !jsonType(response.headers.get('Content-Type'))) return;
      const length = Number(response.headers.get('Content-Length'));
      if (Number.isFinite(length) && length > MAX_RESPONSE) return;
      currentRoute(); if (started.generation !== generation || started.pageUrl !== route) return;
      active++;
      readBounded(response).then(value => { if (value) accept(value, started); }).catch(() => {}).finally(() => { active--; });
    } catch {}
  }
  const originalFetch = globalThis.fetch;
  if (typeof originalFetch === 'function') {
    const requestUrl = globalThis.Request && Object.getOwnPropertyDescriptor(Request.prototype, 'url')?.get;
    const urlHref = Object.getOwnPropertyDescriptor(URL.prototype, 'href')?.get;
    globalThis.fetch = function fetch(input) {
      let started; try { started = begin(); } catch {}
      const pending = Reflect.apply(originalFetch, this, arguments);
      if (!started) return pending;
      let url = '';
      try {
        if (typeof input === 'string') url = input;
        else { try { url = requestUrl?.call(input) || ''; } catch { url = urlHref?.call(input) || ''; } }
      } catch {}
      const target = eligible(url);
      if (!target) return pending;
      return Promise.resolve(pending).then(response => { observeFetch(response, target, started); return response; });
    };
  }
  const XHR = globalThis.XMLHttpRequest;
  if (XHR?.prototype) {
    const records = new WeakMap(), open = XHR.prototype.open, send = XHR.prototype.send;
    XHR.prototype.open = function openObserved(method, url) {
      const result = Reflect.apply(open, this, arguments);
      records.set(this, {url:typeof url === 'string' ? eligible(url) : ''}); return result;
    };
    XHR.prototype.send = function sendObserved() {
      const record = records.get(this); let started, listener;
      try { started = begin(); } catch {}
      if (record?.url && started) {
        listener = () => {
          try {
            currentRoute();
            if (active >= MAX_ACTIVE || started.generation !== generation || started.pageUrl !== route || this.status < 200 || this.status >= 300 ||
                !eligible(this.responseURL || record.url) || !jsonType(this.getResponseHeader('Content-Type'))) return;
            const declared = Number(this.getResponseHeader('Content-Length'));
            if (Number.isFinite(declared) && declared > MAX_RESPONSE) return;
            if (this.responseType === 'json') accept(this.response, started);
            else if (this.responseType === '' || this.responseType === 'text') {
              const text = this.responseText;
              if (boundedText(text)) accept(JSON.parse(text), started);
            }
          } catch {}
        };
        this.addEventListener('loadend', listener, {once:true});
      }
      try { return Reflect.apply(send, this, arguments); }
      catch (error) { if (listener) this.removeEventListener('loadend', listener); throw error; }
    };
  }
  // Generation prevents a delayed A response being accepted after A -> B -> A.
  for (const method of ['pushState','replaceState']) {
    const original = history[method];
    if (typeof original === 'function') history[method] = function observedHistory() { const result = Reflect.apply(original, this, arguments); try { currentRoute(); } catch {} return result; };
  }
  const routeEvent = () => { try { currentRoute(); } catch {} };
  addEventListener('popstate', routeEvent); addEventListener('hashchange', routeEvent);
})();
