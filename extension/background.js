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
// An fMP4 initializer or segment may have the same MIME and extension as a
// whole movie. Match rendition tokens such as "v1-a1", not arbitrary titles.
const trackFragmentName = /^(?:init|seg(?:ment)?|chunk|frag(?:ment)?)(?:[-_.]\d+)*[-_.][va]\d+(?:[-_.][va]?\d+)*\.(?:mp4|m4a|aac)$/i;
const pending = new Map();
const requests = new Map();
const probes = new Map();
const probeAccept = 'application/vnd.apple.mpegurl, application/x-mpegurl;q=0.9, */*;q=0.5';
const probeScope = (tabId, documentId, url) => JSON.stringify([tabId, documentId, url]);
const probeStorageKey = async scope => 'playlist-probe:' + await routeKey(scope);
const mediaRequests = {urls: ['http://*/*', 'https://*/*'],
  types: ['main_frame', 'sub_frame', 'media', 'xmlhttprequest', 'object', 'other']};
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
  const state = (await chrome.storage.session.get(key))[key];
  if (!state) return newState();
  if (!state.trackFragmentsChecked) {
    state.items = state.items.filter(item => {
      if (item.kind !== 'video' && item.kind !== 'audio') return true;
      return !trackFragmentName.test(item.name) &&
        !trackFragmentName.test(decode(new URL(item.url).pathname.split('/').pop()));
    });
    await saveState(tabId, state);
  }
  return state;
}

async function saveState(tabId, state) {
  const key = keyFor(tabId);
  const value = {[key]: {...state, trackFragmentsChecked: true, updatedAt: Date.now()}};
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
  if (from !== 'main_frame' && (trackFragmentName.test(basename) || trackFragmentName.test(suggested))) return null;
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
    if (item.playlistSeenAt) update.playlistSeenAt = Math.max(item.playlistSeenAt, existing.playlistSeenAt || 0);
    if (Object.keys(update).every(key => existing[key] === update[key])) return false;
    Object.assign(existing, update);
    return true;
  }
  // A page can link to hundreds of media files. Keep its player and captured
  // requests ahead of incidental links, with stable IDs across repeated scans.
  const weight = row => row.url.length + row.name.length + (row.referrer?.length || 0) +
    (row.requestOrigin?.length || 0) + 300;
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

function httpOrigin(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return '';
  try {
    const url = new URL(value);
    return !url.username && !url.password ? url.origin : '';
  } catch { return ''; }
}

chrome.webRequest.onSendHeaders.addListener(details => {
  const {requestId, tabId, method, requestHeaders, initiator} = details;
  requests.delete(requestId); // Redirects can keep the ID and send different headers.
  const source = httpOrigin(initiator);
  if (tabId < 0 || method !== 'GET' || !source) return;
  let referrer = '', requestOrigin = '', hadCookies = false, probeFormat = false;
  for (const header of requestHeaders || []) {
    const key = header.name.toLowerCase();
    if (key === 'referer' && httpOrigin(header.value) === source) referrer = source + '/';
    if (key === 'origin' && header.value === source) requestOrigin = source;
    if (key === 'cookie') hadCookies = true;
    if (key === 'accept' && header.value === probeAccept) probeFormat = true;
  }
  // Never copy cookie values, authorization headers or the browsing URL. Keep
  // only a bounded, in-memory record until we know this response is playable.
  if (requests.size >= 2048) requests.delete(requests.keys().next().value);
  const observed = {target: httpOrigin(details.url), referrer, requestOrigin, hadCookies};
  if (probeFormat && details.documentId && details.type === 'xmlhttprequest') {
    const scope = probeScope(tabId, details.documentId, details.url);
    const probe = probes.get(scope);
    if (probe) {
      probe.count++;
      observed.probe = probe;
      observed.trusted = probe.frameId === details.frameId && probe.source === source && !hadCookies &&
        !(requestHeaders || []).some(header => header.name.toLowerCase() === 'authorization');
    } else {
      // On worker restart, an outstanding probe must not become a normal captured response.
      // An ordinary player using the same Accept is unaffected outside this exact document/URL window.
      observed.quarantined = probeStorageKey(scope).then(async key =>
        (await chrome.storage.session.get(key))[key] >= details.timeStamp).catch(() => true);
    }
  }
  requests.set(requestId, observed);
}, mediaRequests, ['requestHeaders', 'extraHeaders']);

chrome.webRequest.onErrorOccurred.addListener(({requestId}) => requests.delete(requestId), mediaRequests);

chrome.webRequest.onHeadersReceived.addListener(details => {
  const {tabId, frameId, documentId, method, statusCode, type} = details;
  const observed = requests.get(details.requestId);
  requests.delete(details.requestId);
  if (observed?.probe) {
    const ok = observed.trusted && observed.probe.scope === probeScope(tabId, documentId, details.url) &&
      method === 'GET' && type === 'xmlhttprequest' && statusCode === 200;
    observed.probe.resolve(ok ? {referrer: observed.referrer, requestOrigin: observed.requestOrigin} : null);
    return;
  }
  if (tabId < 0 || method !== 'GET' || statusCode < 200 || statusCode >= 300 ||
      details.initiator === 'chrome-extension://' + chrome.runtime.id) return;
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
  if (item.kind === 'hls') item.playlistSeenAt = details.timeStamp || Date.now();
  if (observed && observed.target === httpOrigin(item.url)) {
    item.referrer = observed.referrer;
    item.requestOrigin = observed.requestOrigin;
    item.hadCookies = observed.hadCookies;
  }
  inOrder(tabId, async () => {
    if (observed?.quarantined && await observed.quarantined) return;
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
}, mediaRequests, ['responseHeaders']);

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
    if (event.frameId === 0) await clearDownloadRule(event.tabId);
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
  inOrder(tabId, async () => {
    await clearDownloadRule(tabId);
    await chrome.storage.session.remove(keyFor(tabId));
  }).catch(console.warn);
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
        if (item.kind === 'hls' && candidate.from === 'timing') item.playlistSeenAt = candidate.time;
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
      items: [...unique.values()].map(({frameId, documentId, named, rank, referrer, requestOrigin, playlistSeenAt,
        hadCookies, ...item}) => item)};
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
  return {item, items: state.items, frame};
}

function playlistAlternatives(master, items) {
  const root = new URL(master.url);
  if (master.kind !== 'hls' || !master.documentId ||
      !/^master\.m3u8?$/i.test(decode(root.pathname.split('/').pop()))) return [];
  const directory = new URL('.', root).href;
  const variants = new Map();
  for (const row of items) {
    if (row.kind !== 'hls' || row.frameId !== master.frameId || row.documentId !== master.documentId ||
        (!row.playlistSeenAt && row.source !== 'network' && row.rank !== 1)) continue;
    const url = new URL(row.url);
    if (new URL('.', url).href !== directory || url.pathname === root.pathname) continue;
    // A failed master provides no track list. Only offer observed siblings with
    // conventional variant names; an unrelated or ad playlist can share this directory.
    const name = decode(url.pathname.split('/').pop());
    if (!/^(?:(?:index|variant|track|stream|playlist|chunklist|level)(?:[-_.](?:[av]?\d+(?:p|k)?|audio|video|low|medium|high|sd|hd|uhd))*|\d+p)\.m3u8?$/i.test(name)) continue;
    const previous = variants.get(url.pathname);
    if (!previous || (row.playlistSeenAt || 0) >= (previous.playlistSeenAt || 0)) variants.set(url.pathname, row);
  }
  return [...variants.values()].sort((a, b) => (b.playlistSeenAt || 0) - (a.playlistSeenAt || 0))
    .slice(0, 6).map(({id, name}) => ({id, name}));
}

// Session rules survive worker suspension. One ID per download tab makes
// replace/remove atomic; the storage marker avoids DNR work on ordinary tabs.
const ruleKey = tabId => 'download-rule:' + tabId;
async function clearDownloadRule(tabId) {
  const key = ruleKey(tabId);
  if (!(await chrome.storage.session.get(key))[key]) return;
  await chrome.declarativeNetRequest.updateSessionRules({removeRuleIds: [tabId + 1]});
  await chrome.storage.session.remove(key);
}

async function isCurrentDownloadPage(sender) {
  const tabId = sender.tab.id;
  // webNavigation.getFrame does not reliably expose extension documents.
  if (chrome.runtime.getContexts && sender.documentId) {
    const contexts = await chrome.runtime.getContexts({contextTypes: ['TAB'],
      tabIds: [tabId], documentIds: [sender.documentId]});
    return contexts.length > 0;
  }
  // Chrome 106–115 can omit URL fields without the general tabs permission.
  // The authenticated sender and the tab/initiator restrictions still apply.
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  return tab && (!tab.url || tab.url === sender.url) && (!tab.pendingUrl || tab.pendingUrl === sender.url);
}

// Runs in the isolated world of precisely the document that recorded this URL.
async function verifyTimedPlaylist(url, time, source, accept, deadline) {
  if (location.origin !== source || Date.now() >= deadline) return false;
  const seen = performance.getEntriesByName(url, 'resource').some(entry =>
    ['fetch', 'xmlhttprequest', 'audio', 'video'].includes(entry.initiatorType) &&
    !(entry.responseStatus >= 400) && Math.abs(performance.timeOrigin + entry.startTime - time) < 1);
  if (!seen) return false;
  let response, reader;
  try {
    response = await fetch(url, {method: 'GET', mode: 'cors', credentials: 'omit', redirect: 'error',
      cache: 'no-store', headers: {Accept: accept}, referrer: location.origin + '/',
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now()))});
    if (response.status !== 200 || response.url !== url || !response.body) return false;
    // BYOB bounds the amount read even for a URL serving a large non-playlist body.
    reader = response.body.getReader({mode: 'byob'});
    const prefix = new Uint8Array(16);
    let used = 0;
    while (used < prefix.length) {
      const {value, done} = await reader.read(new Uint8Array(prefix.length - used));
      if (done || !value.length) break;
      prefix.set(value, used);
      used += value.length;
      if (value.includes(10)) break;
    }
    return /^#EXTM3U\r?\n/.test(new TextDecoder().decode(prefix.subarray(0, used)));
  } catch {
    return false;
  } finally {
    if (reader) await reader.cancel().catch(() => {});
    else if (response?.body) await response.body.cancel().catch(() => {});
  }
}

function recoverPlaylist(tabId, item, frame) {
  const scope = probeScope(tabId, item.documentId, item.url);
  const existing = probes.get(scope);
  if (existing) return existing.result;
  const probe = {scope, source: httpOrigin(frame.url), frameId: item.frameId, count: 0};
  const headers = new Promise(resolve => { probe.resolve = resolve; });
  probes.set(scope, probe);
  probe.result = (async () => {
    const deadline = Date.now() + 3500;
    let key, timer, injection, injectionFinished = false;
    const cleanup = async () => {
      if (key) await chrome.storage.session.remove(key).catch(() => {});
      probes.delete(scope);
    };
    try {
      key = await probeStorageKey(scope);
      await chrome.storage.session.set({[key]: deadline + 1000});
      injection = chrome.scripting.executeScript({target: {tabId, documentIds: [item.documentId]},
        world: 'ISOLATED', func: verifyTimedPlaylist,
        args: [item.url, item.playlistSeenAt, probe.source, probeAccept, deadline]})
        .finally(() => { injectionFinished = true; });
      const checked = injection.then(([scan]) =>
        scan?.result === true && scan.documentId === item.documentId && scan.frameId === item.frameId ? headers : null);
      const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(null), 4000); });
      const context = await Promise.race([checked, timeout]);
      return probe.count === 1 ? context : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      // If the source tab is frozen, stop waiting for it, but quarantine its late network events
      // until the isolated task exits or the document is destroyed.
      if (injection && !injectionFinished) injection.then(cleanup, cleanup);
      else await cleanup();
    }
  })();
  return probe.result;
}

async function prepareMedia(tabId, id, sender) {
  const {item, items, frame} = await getMedia(tabId, id);
  const {referrer, requestOrigin, hadCookies, playlistSeenAt, ...result} = item;
  const page = item.kind === 'hls' ? 'hls.html' : 'file.html';
  const url = new URL(sender.url);
  const downloadTab = sender.tab?.id;
  if (url.href.split('#')[0] !== chrome.runtime.getURL(page) || sender.frameId !== 0 ||
      !Number.isInteger(downloadTab) || downloadTab < 0 || url.hash.length < 2) {
    return {ok: true, item: result};
  }
  const target = new URLSearchParams(url.hash.slice(1));
  if (target.get('tab') !== String(tabId) || target.get('item') !== id) throw new Error('下载页对应的资源已变更，请重新打开。');
  const origin = httpOrigin(item.url);
  let context = {referrer, requestOrigin};
  if (item.kind === 'hls' && item.source === 'page' && item.documentId && frame.documentId === item.documentId &&
      item.playlistSeenAt > 0 && httpOrigin(frame.url) && !referrer && !requestOrigin && !hadCookies) {
    if (!await isCurrentDownloadPage(sender)) throw new Error('下载页已关闭或更新，请重新打开。');
    const recovered = await recoverPlaylist(tabId, item, frame);
    // A new same-document route may have invalidated the resource during the probe.
    const current = await getMedia(tabId, id);
    if (current.frame.documentId !== item.documentId) throw new Error('原网页已更新，请重新扫描资源。');
    if (recovered) context = recovered;
  }
  await inOrder(downloadTab, async () => {
    // A queued message from a page that already navigated away must not
    // install a fresh rule after its navigation cleanup.
    if (!await isCurrentDownloadPage(sender)) {
      throw new Error('下载页已关闭或更新，请重新打开。');
    }
    if (!context.referrer && !context.requestOrigin) {
      await clearDownloadRule(downloadTab);
      return;
    }
    // DNR treats *, | and ^ as metacharacters in a urlFilter. Reject such
    // hosts instead of broadening a rule for a nonstandard URL.
    if (!origin || /[*|^]/.test(origin)) throw new Error('此媒体地址无法安全重用网页来源。');
    const requestHeaders = [];
    if (context.referrer) requestHeaders.push({header: 'Referer', operation: 'set', value: context.referrer});
    if (context.requestOrigin) requestHeaders.push({header: 'Origin', operation: 'set', value: context.requestOrigin});
    const ruleId = downloadTab + 1;
    const rule = {id: ruleId, priority: 1, action: {type: 'modifyHeaders', requestHeaders},
      condition: {tabIds: [downloadTab], initiatorDomains: [chrome.runtime.id], requestMethods: ['get'],
        urlFilter: '|' + origin + '/', resourceTypes: ['xmlhttprequest']}};
    const key = ruleKey(downloadTab);
    await chrome.storage.session.set({[key]: true});
    await chrome.declarativeNetRequest.updateSessionRules({removeRuleIds: [ruleId], addRules: [rule]});
  });
  const alternatives = playlistAlternatives(item, items);
  return {ok: true, item: result, ...(hadCookies ? {credentialOrigin: origin} : {}),
    ...(alternatives.length ? {alternatives} : {})};
}

async function downloadMedia(tabId, id) {
  const {item} = await getMedia(tabId, id);
  if (item.kind === 'hls') throw new Error('请打开 HLS 下载页面。');
  if (item.referrer || item.requestOrigin) {
    const params = new URLSearchParams({tab: String(tabId), item: id});
    await chrome.tabs.create({url: chrome.runtime.getURL('file.html') + '#' + params});
    return {ok: true, opened: true};
  }
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
    response = prepareMedia(message.tabId, message.id, sender);
  } else if (message.type === 'DOWNLOAD_MEDIA') response = downloadMedia(message.tabId, message.id);
  else return;
  response.then(respond, error => respond({ok: false, error: error.message || '操作失败，请重试。'}));
  return true;
});
