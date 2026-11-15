/* Pure, bounded extraction of per-clip Douyin media metadata. Never executes page code. */
(() => {
  'use strict';
  const LIMITS = Object.freeze({scripts: 64, scriptChars: 2 * 1024 ** 2, totalChars: 4 * 1024 ** 2,
    nodes: 50000, depth: 24, candidates: 400, urlsPerAddress: 32, variants: 64, parsedTexts: 128});
  const own = (object, key) => object && typeof object === 'object'
    ? Object.getOwnPropertyDescriptor(object, key)?.value : undefined;
  const first = (object, keys) => {
    for (const key of keys) { const value = own(object, key); if (value !== undefined && value !== null) return value; }
  };
  function identity(value) {
    if (typeof value === 'number') value = Number.isSafeInteger(value) && value >= 0 ? String(value) : '';
    return typeof value === 'string' && /^[A-Za-z0-9_.-]{3,120}$/.test(value) ? value : '';
  }
  function context(pageUrl) {
    try {
      const url = new URL(pageUrl);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password &&
        /(^|\.)(douyin\.com|iesdouyin\.com)$/.test(url.hostname) ? url : null;
    } catch { return null; }
  }
  function positive(value) { return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined; }
  function text(value) { return typeof value === 'string' && value.length <= 120 ? value : undefined; }
  function resourceUrl(raw, base) {
    if (typeof raw !== 'string' || !raw || raw.length > 16384 || /[\u0000-\u0020\u007f]/.test(raw)) return '';
    // Some player metadata carries a base64 URL. Decode only an explicit URL field.
    if (!/^(?:https?:|\/)/i.test(raw) && /^[A-Za-z0-9+/]+={0,2}$/.test(raw) && typeof atob === 'function') {
      try { const decoded = atob(raw); if (/^https?:\/\//i.test(decoded)) raw = decoded; } catch {}
    }
    try {
      if (!/^(?:https?:\/\/|\/\/|\/[^/])/i.test(raw)) return '';
      const url = new URL(raw, base);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
          /\.(?:jpe?g|png|webp|gif|svg|heic|avif)(?:$|\?)/i.test(url.pathname)) return '';
      url.hash = ''; return url.href;
    } catch { return ''; }
  }
  function addresses(value, base) {
    const result = [], stack = [{value, depth: 0}];
    let visited = 0;
    while (stack.length && result.length < LIMITS.urlsPerAddress && ++visited <= 256) {
      const {value, depth} = stack.pop();
      if (typeof value === 'string') {
 const url = resourceUrl(value, base); if (url && !result.includes(url)) result.push(url); continue; }
      if (!value || typeof value !== 'object' || depth >= 4) continue;
      if (Array.isArray(value)) {
        for (let index = Math.min(value.length, LIMITS.urlsPerAddress) - 1; index >= 0; index--) stack.push({value: own(value, String(index)), depth: depth + 1});
      } else {
        // Explicit priority keeps main/backup/fallback ordering deterministic.
        const keys = ['src', 'url', 'main_url', 'mainUrl', 'backup_url', 'backupUrl', 'fallback_url', 'fallbackUrl', 'url_list', 'urlList'];
        for (let index = keys.length - 1; index >= 0; index--) {
          const next = own(value, keys[index]); if (next !== undefined) stack.push({value: next, depth: depth + 1});
        }
      }
    }
    return result;
  }
  function createState(pageUrl) {
    return {base: context(pageUrl), entries: new Map(), conflicts: new Set(), seen: new WeakSet(), strings: new Set(),
      nodes: 0, chars: 0, inspectedChars: 0, parsedTexts: 0, failed: false};
  }
  function add(state, id, url, kind, info = {}) {
    if (!url || state.failed) return;
    const parsed = new URL(url), declared = parsed.searchParams.getAll('mime_type');
    if (declared.length > 1 || (declared.length && /^(audio|video)(?:_mp4)?$/.test(declared[0]) && !declared[0].startsWith(kind))) return;
    const previous = state.entries.get(url);
    if (previous && (previous.awemeId !== id || previous.kind !== kind)) { state.conflicts.add(url); return; }
    if (!previous && state.entries.size >= LIMITS.candidates) { state.failed = true; return; }
    const format = String(info.format || '').toLowerCase();
    const mime = /webm/.test(format) ? kind + '/webm' : /mp3/.test(format) ? 'audio/mpeg' : /ogg/.test(format) ? kind + '/ogg' : kind + '/mp4';
    const candidate = {url, kind, mime, awemeId: id, contentId: id, pairId: 'dy-aweme-' + id,
      source: 'page-json', evidence: 'douyin-video-object'};
    for (const key of ['bitrate', 'codec', 'quality', 'audioGroup', 'trackId']) if (info[key] !== undefined) candidate[key] = info[key];
    if (!previous) state.entries.set(url, candidate);
    else if ((candidate.bitrate || 0) > (previous.bitrate || 0)) state.entries.set(url, {...previous, ...candidate});
  }
  function clip(state, object) {
    const snakeId = identity(own(object, 'aweme_id')), camelId = identity(own(object, 'awemeId'));
    if (snakeId && camelId && snakeId !== camelId) return;
    const id = snakeId || camelId, video = own(object, 'video');
    if (!id || !video || typeof video !== 'object' || Array.isArray(video)) return;
    const videoInfo = info => ({bitrate: positive(first(info, ['bit_rate', 'bitRate', 'bitrate'])),
      codec: text(first(info, ['codec_type', 'codecType', 'codec'])), quality: text(first(info, ['gear_name', 'gearName', 'quality_desc', 'qualityDesc'])), format: text(own(info, 'format'))});
    for (const key of ['play_addr', 'play_addr_h264', 'play_addr_265', 'play_addr_lowbr', 'playAddr', 'playAddrH264', 'playAddrH265']) {
      for (const url of addresses(own(video, key), state.base)) add(state, id, url, 'video', videoInfo(video));
    }
    const rates = first(video, ['bit_rate', 'bitRateList', 'bitRate']);
    if (Array.isArray(rates)) for (let index = 0; index < Math.min(rates.length, LIMITS.variants); index++) {
      const rate = own(rates, String(index));
      for (const url of addresses(first(rate, ['play_addr', 'playAddr']), state.base)) add(state, id, url, 'video', videoInfo(rate));
    }
    // music.play_url is background music, NOT the complete soundtrack of this clip.
    const audioRates = first(video, ['bit_rate_audio', 'bitRateAudioList', 'bitRateAudio']);
    if (!Array.isArray(audioRates)) return;
    for (let index = 0; index < Math.min(audioRates.length, LIMITS.variants); index++) {
      const rate = own(audioRates, String(index)), meta = first(rate, ['audio_meta', 'audioMeta']);
      if (!meta || typeof meta !== 'object') continue;
      const role = first(meta, ['media_type', 'mediaType']);
      if (typeof role === 'string' && role && !/^audio(?:_mp4|\/[^\s]+)?$/i.test(role)) continue;
      const trackId = identity(first(meta, ['file_id', 'fileId', 'file_hash', 'fileHash']));
      const audioGroup = 'dy-audio-' + id + '-' + (trackId || index);
      const info = {bitrate: positive(first(meta, ['bitrate', 'bit_rate', 'bitRate'])),
        codec: text(first(meta, ['codec_type', 'codecType', 'encoded_type', 'encodedType'])),
        quality: text(first(meta, ['quality_desc', 'qualityDesc', 'quality'])), format: text(own(meta, 'format')),
        audioGroup, trackId: trackId || audioGroup};
      for (const url of addresses(first(meta, ['url_list', 'urlList']), state.base)) add(state, id, url, 'audio', info);
    }
  }
  // Find JSON values in a React Flight string; never evaluate JavaScript.
  function embedded(state, source, depth) {
    let start = -1, level = 0, quoted = false, escaped = false;
    for (let at = 0; at < source.length && state.parsedTexts < LIMITS.parsedTexts; at++) {
      const char = source[at];
      if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue; }
      if (char === '"') { quoted = true; continue; }
      if (char === '{' || char === '[') { if (!level) start = at; if (++level > 64) return; }
      else if ((char === '}' || char === ']') && level && --level === 0) parseText(state, source.slice(start, at + 1), depth + 1, false);
    }
  }
  function parseText(state, raw, depth = 0, findEmbedded = true) {
    if (state.failed || depth > LIMITS.depth || typeof raw !== 'string' || raw.length > LIMITS.scriptChars || state.strings.has(raw)) return;
    state.strings.add(raw);
    let source = raw.trim();
    if (!source) return;
    if (/^(?:%7[bB]|%5[bB]|%22)/.test(source)) { try { source = decodeURIComponent(source); } catch { return; } }
    state.chars += source.length;
    if (state.chars > LIMITS.totalChars || ++state.parsedTexts > LIMITS.parsedTexts) { state.failed = true; return; }
    try { walk(state, JSON.parse(source), depth); }
    catch { if (findEmbedded) embedded(state, source, depth); }
  }
  function walk(state, root, depth = 0) {
    const stack = [{value: root, depth}];
    while (stack.length && !state.failed) {
      const {value, depth} = stack.pop();
      if (++state.nodes > LIMITS.nodes) { state.failed = true; break; }
      if (typeof value === 'string') {
        state.inspectedChars += value.length;
        if (value.length > LIMITS.scriptChars || state.inspectedChars > LIMITS.totalChars) { state.failed = true; break; }
        if (/^(?:\s*[\[{]|%7[bB]|%5[bB])/.test(value) || /(?:^|\n)[0-9a-f]+:\s*[\[{]/.test(value)) parseText(state, value, depth + 1);
        continue;
      }
      if (!value || typeof value !== 'object' || state.seen.has(value)) continue;
      if (depth >= LIMITS.depth) { state.failed = true; break; }
      state.seen.add(value); clip(state, value);
      if (Array.isArray(value) && value.length > LIMITS.nodes) { state.failed = true; break; }
      let keys = 0;
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        if (++keys + state.nodes + stack.length > LIMITS.nodes) { state.failed = true; break; }
        const child = own(value, key); if (child !== undefined) stack.push({value: child, depth: depth + 1});
      }
    }
  }
  function result(state) { return state.failed ? [] : [...state.entries.values()].filter(entry => !state.conflicts.has(entry.url)); }
  function extractJson(value, {pageUrl} = {}) {
    const state = createState(pageUrl); if (!state.base) return [];
    walk(state, value); return result(state);
  }
  function extract({scripts, pageUrl} = {}) {
    const state = createState(pageUrl); if (!state.base || !Array.isArray(scripts)) return [];
    for (const script of scripts.slice(0, LIMITS.scripts)) {
      const raw = own(script, 'text'), id = String(own(script, 'id') || ''), type = String(own(script, 'type') || '');
      if (typeof raw !== 'string' || raw.length > LIMITS.scriptChars) continue;
      const carrier = /^(RENDER_DATA|SIGI_STATE|sigi-persisted-data|__NEXT_DATA__|__UNIVERSAL_DATA_FOR_REHYDRATION__)$/.test(id) ||
        /^(application\/json|application\/ld\+json)$/i.test(type.split(';')[0]) || /^\s*[\[{]/.test(raw);
      if (carrier) parseText(state, raw);
      else if (/\b(?:self|window)\.__pace_f\b/.test(raw)) embedded(state, raw, 0);
      if (state.failed) break;
    }
    return result(state);
  }
  globalThis.ShiliuPageMedia = Object.freeze({extract, extractJson, LIMITS});
})();




