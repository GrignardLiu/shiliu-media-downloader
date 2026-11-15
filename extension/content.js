// Executed in each accessible frame when the popup asks for a fresh scan.
(() => {
  const candidates = new Map();
  const knownPath = /\.(?:mp4|m4v|webm|mov|mkv|avi|flv|wmv|mpe?g|ogv|3gp|ts|mp3|m4a|aac|ogg|oga|opus|wav|flac|weba|aif?f|amr|ac3|m3u8?|mpd)$/i;
  const mediaType = /^(?:audio\/|video\/|application\/(?:vnd\.apple\.mpegurl|x-mpegurl|dash\+xml|ogg))/i;
  const htmlPage = ['text/html', 'application/xhtml+xml'].includes(document.contentType)
    ? document.URL.split('#')[0] : '';
  const timings = new Map();
  for (const entry of performance.getEntriesByType('resource').slice(-700).reverse()) {
    const url = entry.name.split('#')[0];
    if (!timings.has(url)) timings.set(url, entry);
  }
  let hasBlob = false;
  const pageUrl = document.URL || document.baseURI;
  function currentOwner() {
    try {
      const url = new URL(pageUrl);
      if (!/(^|\.)(douyin\.com|iesdouyin\.com)$/.test(url.hostname)) return null;
      const values = key => url.searchParams.getAll(key).filter(Boolean);
      const choose = ids => ids.some(id => !/^[\w.-]{3,120}$/.test(id)) || new Set(ids).size > 1 ? null : ids[0] || '';
      // A modal can show a new clip above an older detail URL underneath it.
      const modal = values('modal_id');
      if (modal.length) return choose(modal);
      const path = /^\/(?:video|note)\/([\w.-]{3,120})(?:\/|$)/.exec(url.pathname)?.[1];
      if (path) return path;
      return choose(['aweme_id','item_id','id'].flatMap(values));
    } catch { return null; }
  }
  const owner = currentOwner();
  const owns = item => owner !== null && (!owner || item.awemeId === owner);

  function add(raw, kind, mime, from, time = 0, association = null, currentPlayer = false) {
    if (!raw || raw.length > 16384 || !raw.trim() || raw.trimStart().startsWith('#')) return;
    let parsed;
    try {
      parsed = new URL(raw, document.baseURI);
    } catch {
      return;
    }
    if (parsed.protocol === 'blob:' && kind) hasBlob = true;
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return;
    parsed.hash = '';
    const url = parsed.href;
    const response = timings.get(url);
    // Links and <source> tags can remain in the page after a 403 or 404.
    if (response?.responseStatus >= 400) return;
    const received = response?.contentType?.split(';')[0].trim().toLowerCase();
    // An empty or "#"-only player source can resolve to the HTML document itself.
    if (url === htmlPage && !mediaType.test(received || '')) return;
    if (received && !['application/octet-stream','text/plain'].includes(received)) mime = received;
    const prior = candidates.get(url);
    if (!prior && !kind && !mediaType.test(mime) && !knownPath.test(parsed.pathname)) return;
    if (!prior && candidates.size >= 160) return;
    if (!prior || (!prior.mime && mime && prior.from === from)) {
      candidates.set(url, {url, kind, mime, from, time});
    } else if (from === 'link' && prior.from === 'timing') {
      // An explicit link is still present even if its corresponding request predates a SPA route change.
      candidates.set(url, {...prior, from, time: 0});
    }
    if (currentPlayer && candidates.has(url)) candidates.get(url).currentPlayer = true;
    if (association && candidates.has(url)) {
      const item = candidates.get(url);
      if (Number.isFinite(item.metadataObservedAt) && association.metadataObservedAt < item.metadataObservedAt) return;
      if (!item.metadata) { item.baseKind = item.kind; item.baseMime = item.mime; }
      if (!item.mime && association.mime) item.mime = association.mime;
      for (const key of ['pairId','contentId','videoId','awemeId','audioGroup','evidence','codec','bitrate']) {
        if (association[key] === undefined) continue;
        if (['pairId','contentId','videoId','awemeId'].includes(key) && item[key] && item[key] !== association[key]) item.associationConflict = true;
        item[key] = association[key];
      }
      // Preserve the actual DOM/timing provenance while attaching parser-only
      // metadata separately for background's bounded association validation.
      item.metadata = true;
      item.metadataTrack = association.kind;
      item.metadataObservedAt = association.metadataObservedAt;
      item.metadataSource = association.metadataSource;
    }
  }

  const roots = [document];
  for (const root of roots) {
    for (const element of root.querySelectorAll('*')) {
      if (element.shadowRoot) roots.push(element.shadowRoot);
    }
    for (const player of root.querySelectorAll('video, audio')) {
      const kind = player.localName;
      if (player.srcObject) hasBlob = true;
      add(player.currentSrc, kind, '', 'element', 0, null, true);
      add(player.getAttribute('src'), kind, '', 'element');
      for (const source of player.querySelectorAll('source[src]')) {
        add(source.getAttribute('src'), kind, source.type, 'element');
      }
    }
  }

  // A newly installed extension can use the page's existing timing buffer.
  for (const entry of timings.values()) {
    const kind = ['video', 'audio'].includes(entry.initiatorType) ? entry.initiatorType : '';
    add(entry.name, kind, entry.contentType || '', 'timing', performance.timeOrigin + entry.startTime);
  }
  for (const root of roots) {
    for (const link of root.querySelectorAll('a[href]')) {
      add(link.getAttribute('href'), '', link.type || '', 'link');
    }
  }
  if (globalThis.ShiliuPageMedia) {
    const scripts = []; let total = 0;
    for (const script of document.querySelectorAll('script')) {
      const text = script.textContent;
      if (scripts.length >= 64 || total >= 2 * 1024 * 1024) break;
      if (script.id === 'shiliu-observed-media') continue;
      if (typeof text !== 'string' || !text || text.length > 1024 * 1024 || total + text.length > 2 * 1024 * 1024) continue;
      scripts.push({id: script.id || '', type: script.type || '', text}); total += text.length;
    }
    for (const item of ShiliuPageMedia.extract({scripts, pageUrl})) {
      if (owns(item)) add(item.url, item.kind, item.mime, 'page-json', 0, {...item,metadataObservedAt:performance.timeOrigin,metadataSource:'ssr'});
    }
  }
  // MAIN-world observer publishes only parsed, bounded associations; never raw
  // API responses. Treat the DOM transport as untrusted and revalidate scope.
  const observedNode = document.getElementById?.('shiliu-observed-media');
  if (observedNode?.tagName === 'SCRIPT' && observedNode.type === 'application/json' &&
      typeof observedNode.textContent === 'string' && observedNode.textContent.length <= 2 * 1024 * 1024) {
    try {
      const data = JSON.parse(observedNode.textContent), now = Date.now();
      if (data.version === 1 && new URL(data.pageUrl).href === new URL(pageUrl).href &&
          Number.isFinite(data.observedAt) && data.observedAt >= performance.timeOrigin && data.observedAt <= now + 1000 &&
          Array.isArray(data.candidates) && data.candidates.length <= 400) {
        for (const item of data.candidates) {
          if (!item || typeof item.url !== 'string' || typeof item.mime !== 'string' || item.mime.length > 120 || item.evidence !== 'douyin-video-object' || !['audio','video'].includes(item.kind) || !owns(item) ||
              !Number.isFinite(item.observedAt) || item.observedAt < performance.timeOrigin || item.observedAt > data.observedAt) continue;
          add(item.url,item.kind,item.mime,'page-observer',0,{...item,metadataObservedAt:item.observedAt,metadataSource:'observer'});
        }
      }
    } catch {} // A corrupt or page-replaced transport never authorizes association.
  }
  return {candidates: [...candidates.values()], hasBlob};
})();
