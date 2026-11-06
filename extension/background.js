const videoExtensions = new Set('mp4 m4v webm mov mkv avi flv wmv mpeg mpg ogv 3gp ts'.split(' '));
const audioExtensions = new Set('mp3 m4a aac ogg oga opus wav flac weba aif aiff amr ac3'.split(' '));
const mimeExtensions = {
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
  'video/x-matroska': 'mkv', 'video/x-msvideo': 'avi', 'video/x-flv': 'flv',
  'video/x-ms-wmv': 'wmv', 'video/mpeg': 'mpeg', 'video/ogg': 'ogv',
  'video/mp2t': 'ts', 'video/3gpp': '3gp', 'video/x-m4v': 'm4v',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/aacp': 'aac',
  'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/wav': 'wav',
  'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/flac': 'flac',
  'audio/x-flac': 'flac', 'audio/webm': 'weba', 'audio/aiff': 'aiff',
  'audio/x-aiff': 'aiff', 'audio/amr': 'amr', 'audio/ac3': 'ac3',
  'application/ogg': 'ogg',
};
const containerAliases = {mp4: ['m4v'], m4a: ['mp4'], weba: ['webm'], ogg: ['oga','opus'],
  ogv: ['ogg'], mpeg: ['mpg'], aiff: ['aif']};
const mediaMime = /^(?:audio|video)\/|mpegurl|dash\+xml|^application\/ogg$/;
const pending = new Map();
const keyFor = tabId => 'media:' + tabId;
const newState = () => ({route: '', since: 0, items: []});

// Serialize reads, mutations, and storage writes per tab across overlapping events.
function inOrder(tabId, operation) {
  const next = (pending.get(tabId) || Promise.resolve()).catch(() => {}).then(operation);
  pending.set(tabId, next);
  next.finally(() => {
    if (pending.get(tabId) === next) pending.delete(tabId);
  }).catch(() => {});
  return next;
}

async function readState(tabId) {
  const key = keyFor(tabId);
  return (await chrome.storage.session.get(key))[key] || newState();
}

async function saveState(tabId, state) {
  const key = keyFor(tabId);
  const value = {[key]: {...state, updatedAt: Date.now()}};
  try {
    await chrome.storage.session.set(value);
  } catch (error) {
    if (!/quota/i.test(error.message)) throw error;
    // The session quota is shared by all tabs. Release the oldest resource
    // caches only when a write runs out of space; leave other extension keys intact.
    const all = await chrome.storage.session.get(null);
    const oldest = Object.keys(all).filter(k => k !== key && /^media:\d+$/.test(k) && all[k].items?.length)
      .sort((a,b) => (all[a].updatedAt || 0) - (all[b].updatedAt || 0));
    let saved = false;
    for (const old of oldest) {
      await chrome.storage.session.remove(old);
      await chrome.action.setBadgeText({tabId: Number(old.slice(6)), text: ''}).catch(() => {});
      try {
        await chrome.storage.session.set(value);
        saved = true;
        break;
      } catch (retryError) {
        if (!/quota/i.test(retryError.message)) throw retryError;
      }
    }
    if (!saved) throw error;
  }
  const count = new Set(state.items.map(item => item.url)).size;
  await chrome.action.setBadgeText({tabId, text: count ? String(count) : ''}).catch(() => {});
}

function decode(text) {
  try { return decodeURIComponent(text); } catch { return text; }
}

function dispositionName(header) {
  const encoded = /(?:^|;)\s*filename\*\s*=\s*UTF-8'[^']*'([^;]+)/i.exec(header);
  if (encoded) return decode(encoded[1].trim());
  const basic = /(?:^|;)\s*filename\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^;]+))/i.exec(header);
  return basic ? (basic[1] || basic[2] || '').replace(/\\(["\\])/g, '$1').trim() : '';
}

function suffix(name) {
  return /\.([a-z0-9]{1,8})$/i.exec(name)?.[1].toLowerCase() || '';
}

function typeByExtension(ext) {
  if (['m3u8', 'm3u'].includes(ext)) return 'hls';
  if (ext === 'mpd') return 'dash';
  if (audioExtensions.has(ext)) return 'audio';
  if (videoExtensions.has(ext)) return 'video';
  return '';
}

function safeName(name, extension, kind) {
  let stem = name.replace(/[/\\]/g, '_').replace(/\.[a-z0-9]{1,8}$/i, '')
    .replace(/[<>:"|?*\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 130).replace(/[.\s]+$/g, '');
  if (!stem) stem = {video: '视频', audio: '音频', hls: '播放列表', dash: '媒体清单'}[kind];
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])($|\.)/i.test(stem)) stem = '_' + stem;
  return extension ? stem + '.' + extension : stem.replace(/\./g, '_');
}

function describe(rawUrl, rawMime = '', suggested = '', hint = '', from = '') {
  if (typeof rawUrl !== 'string' || rawUrl.length > 16384) return null;
  let parsed;
  try { parsed = new URL(rawUrl); } catch { return null; }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
  parsed.hash = '';
  const basename = decode(parsed.pathname.split('/').pop());
  const mime = rawMime.split(';')[0].trim().toLowerCase().slice(0, 120);
  if (/^(?:image\/|font\/|text\/(?:html|css|javascript)|application\/(?:json|javascript|xhtml\+xml))/.test(mime)) return null;
  const ext = [suffix(suggested), suffix(basename)].find(typeByExtension) || '';
  const extKind = typeByExtension(ext);
  const declared = /^(audio|video)\//.exec(mime)?.[1] || (mime === 'application/ogg' ? 'audio' : '');
  if (mime.includes('mpegurl') || (!declared && mime !== 'application/dash+xml' && extKind === 'hls')) {
    return media('hls', extKind === 'hls' ? ext : 'm3u8');
  }
  if (mime === 'application/dash+xml' || (!declared && extKind === 'dash')) return media('dash', 'mpd');

  // Browser fetches for MSE fragments are usually unusable on their own.
  if (/\.(m4s|m4f|cmfv|cmfa|ismv|isma)$/i.test(basename) || mime.includes('iso.segment')) return null;
  if (from !== 'element' && from !== 'link' && from !== 'media' && from !== 'main_frame') {
    if (ext === 'ts' || mime === 'video/mp2t' ||
        /^(?:init|seg(?:ment)?|chunk|fragment)[\d._-]*\.(?:mp4|aac|m4a)$/i.test(basename)) return null;
  }
  const container = Object.hasOwn(mimeExtensions, mime) ? mimeExtensions[mime] : '';
  const sharedContainer = ['mp4','webm','ogg'].includes(ext);
  const kind = declared || (sharedContainer && hint) || typeByExtension(container) || extKind || hint;
  if (kind !== 'audio' && kind !== 'video') return null;
  const compatible = ext === container || containerAliases[container]?.includes(ext);
  const extension = container ? (compatible ? ext : container) : (sharedContainer || extKind === kind ? ext : '');
  return media(kind, extension);

  function media(kind, extension) {
    return {url: parsed.href, kind, extension, mime, named: Boolean(suggested),
      name: safeName(suggested || basename, extension, kind)};
  }
}

function upsert(state, item, frameId, documentId, source, size = null, rank = 2) {
  const existing = state.items.find(row => row.url === item.url && row.frameId === frameId &&
    row.documentId === documentId);
  if (existing) {
    // Prefer the server's filename, MIME type and total byte count over a DOM guess.
    const update = {rank: Math.max(rank, existing.rank ?? 0)};
    if (existing.source === 'network' && source === 'page' && rank === 3 && !mediaMime.test(existing.mime)) {
      Object.assign(update, {kind: item.kind, extension: item.extension, mime: item.mime || existing.mime,
        name: safeName(existing.name, item.extension, item.kind)});
    } else if (source === 'network' || existing.source !== 'network') {
      Object.assign(update, item, {source, size: size ?? existing.size});
      if (existing.source === 'network' && !mediaMime.test(item.mime) && mediaMime.test(existing.mime)) {
        Object.assign(update, {mime: existing.mime, kind: existing.kind, extension: existing.extension});
      }
      if (!item.named && existing.named) {
        update.name = safeName(existing.name, update.extension, update.kind);
        update.named = true;
      } else if (update.extension !== item.extension) {
        update.name = safeName(item.name, update.extension, update.kind);
      }
    }
    if (Object.keys(update).every(key => existing[key] === update[key])) return false;
    Object.assign(existing, update);
    return true;
  }
  // A page can link to hundreds of media files. Keep its player and captured
  // requests ahead of incidental links, with stable IDs across repeated scans.
  const weight = row => row.url.length + row.name.length + 300;
  let chars = state.items.reduce((sum, row) => sum + weight(row), weight(item));
  if (state.items.length >= 120 || chars > 75000) {
    const byRank = [...state.items].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
    const evicted = new Set();
    for (const row of byRank) {
      const priorRank = row.rank ?? 0;
      if (priorRank > rank || (priorRank === rank && source !== 'network')) return false;
      evicted.add(row);
      chars -= weight(row);
      if (chars <= 75000 && state.items.length - evicted.size < 120) break;
    }
    state.items = state.items.filter(row => !evicted.has(row));
  }
  state.items.push({...item, id: crypto.randomUUID(), frameId, documentId, source, size, rank});
  return true;
}

function headerSize(headers, status) {
  const range = /^bytes\s+\d+-\d+\/(\d+)$/i.exec(headers['content-range'] || '');
  const raw = range ? range[1] : status === 206 ? '' : headers['content-length'];
  if (!raw || !/^\d+$/.test(raw)) return null;
  const size = Number(raw);
  return Number.isSafeInteger(size) ? size : null;
}

chrome.webRequest.onHeadersReceived.addListener(details => {
  const {tabId, frameId, documentId, method, statusCode, type} = details;
  if (tabId < 0 || method !== 'GET' || statusCode < 200 || statusCode >= 300) return;
  const headers = {};
  for (const header of details.responseHeaders || []) {
    const key = header.name.toLowerCase();
    if (['content-type','content-length','content-range','content-disposition'].includes(key)) {
      headers[key] = header.value || '';
    }
  }
  const item = describe(details.url, headers['content-type'],
    dispositionName(headers['content-disposition'] || ''), '', type);
  if (!item) return;
  inOrder(tabId, async () => {
    // A response can arrive after the page or iframe that initiated it is gone.
    if (documentId && !['main_frame','sub_frame'].includes(type)) {
      const frame = await chrome.webNavigation.getFrame({tabId, frameId}).catch(() => null);
      if (!frame || (frame.documentId && frame.documentId !== documentId)) return;
    }
    const state = await readState(tabId);
    if (upsert(state, item, frameId, documentId || '', 'network', headerSize(headers, statusCode))) {
      await saveState(tabId, state);
    }
  }).catch(console.warn);
}, {urls: ['http://*/*','https://*/*'], types: ['main_frame','sub_frame','media','xmlhttprequest','object','other']},
['responseHeaders']);

function route(url) {
  if (!/^https?:\/\//i.test(url)) return '';
  // Hash-router URLs represent distinct SPA pages; ordinary section anchors do not.
  const hash = url.indexOf('#');
  return hash < 0 || /^#!?\//.test(url.slice(hash)) ? url : url.slice(0, hash);
}

// Only retain an opaque comparison key for SPA navigation, never the browsing URL.
async function routeKey(url) {
  if (!url) return '';
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url));
  return btoa(String.fromCharCode(...new Uint8Array(hash)));
}

chrome.webNavigation.onCommitted.addListener(event => {
  if (event.tabId < 0) return;
  inOrder(event.tabId, async () => {
    const state = await readState(event.tabId);
    const main = event.frameId === 0;
    const url = route(event.url);
    const previousCount = state.items.length;
    state.items = state.items.filter(item => {
      if (!main && item.frameId !== event.frameId) return true;
      if (item.documentId && item.documentId === event.documentId) return true;
      // Response headers for navigating directly to a media file precede commit.
      if (item.frameId === event.frameId && item.url === url) {
        item.documentId = event.documentId || '';
        return true;
      }
      return false;
    });
    if (main) {
      state.route = await routeKey(url);
      state.since = 0;
    }
    if (main || previousCount) await saveState(event.tabId, state);
  }).catch(console.warn);
});

function updateRoute(event) {
  if (event.frameId !== 0 || event.tabId < 0) return;
  inOrder(event.tabId, async () => {
    const state = await readState(event.tabId);
    const key = await routeKey(route(event.url));
    if (key !== state.route) {
      state.route = key;
      state.since = event.timeStamp;
      state.items = [];
      await saveState(event.tabId, state);
    }
  }).catch(console.warn);
}
chrome.webNavigation.onHistoryStateUpdated.addListener(updateRoute);
chrome.webNavigation.onReferenceFragmentUpdated.addListener(updateRoute);

chrome.tabs.onRemoved.addListener(tabId => {
  inOrder(tabId, () => chrome.storage.session.remove(keyFor(tabId))).catch(console.warn);
});
chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeBackgroundColor({color: '#0F766E'});
});

async function listMedia(tabId) {
  return inOrder(tabId, async () => {
    const scanFrames = allFrames => chrome.scripting.executeScript({
      target: {tabId, allFrames}, files: ['content.js'], injectImmediately: true,
    });
    // A restricted child frame should not prevent scanning the top document.
    const scans = await scanFrames(true).catch(() => scanFrames(false).catch(() => []));
    const frames = await chrome.webNavigation.getAllFrames({tabId}).catch(() => null);
    const live = frames && new Map(frames.map(frame => [frame.frameId, frame.documentId]));
    const isLive = row => !live || (live.has(row.frameId) &&
      (!row.documentId || !live.get(row.frameId) || live.get(row.frameId) === row.documentId));
    const state = await readState(tabId);
    const oldCount = state.items.length;
    const observed = new Map();
    const found = [];
    let hasBlob = false;
    for (const scan of scans) {
      if (!isLive(scan) || !scan.result) continue;
      hasBlob ||= scan.result.hasBlob;
      const urls = new Set();
      observed.set(scan.frameId, urls);
      for (const candidate of scan.result.candidates) {
        if (candidate.from === 'timing' && candidate.time < state.since) continue;
        const item = describe(candidate.url, candidate.mime, '', candidate.kind, candidate.from);
        if (!item) continue;
        urls.add(item.url);
        const rank = {element: 3, timing: 1, link: 0}[candidate.from];
        found.push({item, frameId: scan.frameId, documentId: scan.documentId || '', rank});
      }
    }
    state.items = state.items.filter(item => isLive(item) && (item.source === 'network' ||
      !observed.has(item.frameId) || observed.get(item.frameId).has(item.url)));
    let changed = state.items.length !== oldCount;
    for (const {item, frameId, documentId, rank} of found) {
      if (upsert(state, item, frameId, documentId, 'page', null, rank)) changed = true;
    }
    if (changed) await saveState(tabId, state);
    const unique = new Map();
    for (const item of state.items) {
      if (!unique.has(item.url) || item.source === 'network') unique.set(item.url, item);
    }
    return {ok: true, hasBlob, scanBlocked: !scans.some(scan => scan.result),
      items: [...unique.values()].map(({frameId, documentId, named, rank, ...item}) => item)};
  });
}

async function getMedia(tabId, id) {
  const state = await inOrder(tabId, () => readState(tabId));
  const item = state.items.find(row => row.id === id);
  if (!item) throw new Error('页面已更新，请刷新资源列表。');
  const frame = await chrome.webNavigation.getFrame({tabId, frameId: item.frameId}).catch(() => null);
  if (!frame || (item.documentId && frame.documentId && frame.documentId !== item.documentId)) {
    throw new Error('页面已更新，请刷新资源列表。');
  }
  return item;
}

async function downloadMedia(tabId, id) {
  const item = await getMedia(tabId, id);
  if (item.kind === 'hls') throw new Error('请打开 HLS 下载页面。');
  const downloadId = await chrome.downloads.download({
    url: item.url, filename: item.name, conflictAction: 'uniquify',
  });
  return {ok: true, downloadId};
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!sender.url?.startsWith(chrome.runtime.getURL('')) || !Number.isInteger(message?.tabId) ||
      message.tabId < 0) return;
  let response;
  if (message.type === 'LIST_MEDIA') response = listMedia(message.tabId);
  else if (message.type === 'GET_MEDIA') {
    response = getMedia(message.tabId, message.id).then(item => ({ok: true, item}));
  } else if (message.type === 'DOWNLOAD_MEDIA') response = downloadMedia(message.tabId, message.id);
  else return;
  response.then(respond, error => respond({ok: false, error: error.message || '操作失败，请重试。'}));
  return true;
});
