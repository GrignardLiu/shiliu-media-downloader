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

  function add(raw, kind, mime, from, time = 0) {
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
  for (const entry of timings.values()) {
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
