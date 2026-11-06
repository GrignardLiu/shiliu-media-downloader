// Executed in each accessible frame when the popup asks for a fresh scan.
(() => {
  const candidates = new Map();
  const knownPath = /\.(?:mp4|m4v|webm|mov|mkv|avi|flv|wmv|mpe?g|ogv|3gp|ts|mp3|m4a|aac|ogg|oga|opus|wav|flac|weba|aif?f|amr|ac3|m3u8?|mpd)$/i;
  const mediaType = /^(?:audio\/|video\/|application\/(?:vnd\.apple\.mpegurl|x-mpegurl|dash\+xml|ogg))/i;
  let hasBlob = false;

  function add(raw, kind, mime, from, time = 0) {
    if (!raw || raw.length > 16384) return;
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
    const prior = candidates.get(url);
    if (!prior && !kind && !mediaType.test(mime) && !knownPath.test(parsed.pathname)) return;
    if (!prior && candidates.size >= 160) return;
    if (!prior || (!prior.mime && mime && prior.from === from)) {
      candidates.set(url, {url, kind, mime, from, time});
    } else if (from === 'timing' && prior.from === 'element' && mime &&
        !['application/octet-stream','text/plain'].includes(mime)) {
      // Response metadata can reveal an HTML login page behind an apparent player source.
      prior.mime = mime;
    } else if (from === 'link' && prior.from === 'timing') {
      // An explicit link is still present even if its corresponding request predates a SPA route change.
      candidates.set(url, {...prior, from, time: 0});
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
      add(player.currentSrc, kind, '', 'element');
      add(player.getAttribute('src'), kind, '', 'element');
      for (const source of player.querySelectorAll('source[src]')) {
        add(source.getAttribute('src'), kind, source.type, 'element');
      }
    }
  }

  // A newly installed extension can use the page's existing timing buffer.
  const recent = performance.getEntriesByType('resource').slice(-700).reverse();
  const seenTimings = new Set();
  for (const entry of recent) {
    if (seenTimings.has(entry.name)) continue;
    seenTimings.add(entry.name);
    if (entry.responseStatus >= 400) continue;
    const kind = ['video', 'audio'].includes(entry.initiatorType) ? entry.initiatorType : '';
    add(entry.name, kind, entry.contentType || '', 'timing', performance.timeOrigin + entry.startTime);
  }
  for (const root of roots) {
    for (const link of root.querySelectorAll('a[href]')) {
      add(link.getAttribute('href'), '', link.type || '', 'link');
    }
  }
  return {candidates: [...candidates.values()], hasBlob};
})();
