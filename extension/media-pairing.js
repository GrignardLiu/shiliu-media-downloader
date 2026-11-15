/* Shared by classic extension scripts and dependency-free Node tests. */
(() => {
  'use strict';
  const value = input => typeof input === 'string' && /^[\w.-]{3,160}$/.test(input) ? input : '';
  function classify(item) {
    let url;
    try { url = new URL(item.url); } catch { return {track: 'unknown', identities: []}; }
    const mime = String(item.mime || '').split(';')[0].trim().toLowerCase();
    const queryType = url.searchParams.get('mime_type');
    // Douyin serves audio-only AAC-in-MP4 with video/mp4 response headers.
    const queryTrack = /^(audio|video)(?:_mp4)?$/.exec(queryType || '')?.[1];
    const metadataTrack = item.evidence === 'douyin-video-object' && ['audio','video'].includes(item.metadataTrack) ? item.metadataTrack : '';
    const track = queryTrack || metadataTrack || (/^(audio|video)\//.exec(mime)?.[1]) ||
      (['audio', 'video'].includes(item.kind) ? item.kind : 'unknown');
    const identities = [], metadataIdentities = [], urlIdentities = [];
    let conflicted = Boolean(item.associationConflict);
    // Explicit metadata must describe the actual resource, not the current page.
    for (const [field, key] of [['pairId', 'pair'], ['contentId', 'content'], ['videoId', 'video'], ['awemeId', 'aweme']]) {
      const id = value(item[field]);
      if (id) { identities.push(key + ':' + id); metadataIdentities.push(key + ':' + id); }
    }
    const douyin = /(^|\.)(douyin\.com|douyinvod\.com)$/.test(url.hostname);
    if (douyin) {
      for (const [field, key] of [['vid', 'video'], ['video_id', 'video'], ['aweme_id', 'aweme']]) {
        const values = url.searchParams.getAll(field);
        if (values.length > 1 && new Set(values).size > 1) conflicted = true;
        if (values.length === 1 && value(values[0])) { identities.push(key + ':' + values[0]); urlIdentities.push(key + ':' + values[0]); }
      }
    }
    // file_id identifies a rendition; dash, timestamp, path and tab do not prove identity.
    for (const group of [metadataIdentities, urlIdentities]) for (const id of group) {
      const prefix = id.split(':')[0] + ':';
      if (group.some(other => other.startsWith(prefix) && other !== id)) conflicted = true;
    }
    return {track, identities: [...new Set(identities)], metadataIdentities, urlIdentities, conflicted};
  }
  function isMp4(item) {
    let url;
    try { url = new URL(item.url); } catch { return false; }
    const mime = String(item.mime || '').split(';')[0].trim().toLowerCase();
    const extension = String(item.extension || '').replace(/^\./, '').toLowerCase();
    const queryType = url.searchParams.get('mime_type');
    // Explicitly incompatible containers must not enter the MP4 muxer.
    if (/webm|ogg/.test(mime) || /^(webm|weba|ogg|oga)$/.test(extension)) return false;
    return /^(mp4|m4v|m4a)$/.test(extension) || /^(video|audio)\/mp4$/.test(mime) ||
      /^(audio|video)_mp4$/.test(queryType || '') || /\.(mp4|m4v|m4a)$/i.test(url.pathname);
  }
  function findAudio(items, videoItem, rows = items.map(item => ({item, ...classify(item)}))) {
    const video = rows.find(row => row.item === videoItem) || {item: videoItem, ...classify(videoItem)};
    if (video.track !== 'video' || video.conflicted || !isMp4(videoItem)) return {audio: null, reason: 'none'};
    const candidates = [];
    for (const audio of rows) {
      const item = audio.item;
      if (audio.track !== 'audio' || audio.conflicted || !isMp4(item) || videoItem.url === item.url) continue;
      if (videoItem.frameId !== item.frameId || videoItem.documentId !== item.documentId) continue;
      const identity = video.identities.find(id => audio.identities.includes(id));
      if (!identity) continue;
      // A literal owning-video object is stronger than CDN vid values, which
      // can identify renditions. Never use the current page's ID as this proof.
      const sameOwner = videoItem.evidence === 'douyin-video-object' && item.evidence === 'douyin-video-object' &&
        value(videoItem.pairId) && videoItem.pairId === item.pairId && value(videoItem.awemeId) && videoItem.awemeId === item.awemeId;
      const left = sameOwner ? video.metadataIdentities : video.identities;
      const right = sameOwner ? audio.metadataIdentities : audio.identities;
      const contradictory = [...left, ...right].some(id => {
        const prefix = id.split(':')[0] + ':';
        return left.some(v => v.startsWith(prefix)) && right.some(a => a.startsWith(prefix)) &&
          (!left.includes(id) || !right.includes(id));
      });
      if (!contradictory) candidates.push({audio: item, identity});
    }
    if (!candidates.length) return {audio: null, reason: 'none'};
    if (candidates.length === 1) return {...candidates[0], reason: 'matched'};
    // URL identity alone cannot rank distinct audio tracks. Explicit owning-video
    // metadata can rank equivalent encodings; ties remain ambiguous unless the
    // parser proved they are backup URLs for the same audio entry.
    const score = item => {
      const known = item.evidence === 'douyin-video-object';
      return [known ? 1 : 0, known && /aac|mp4a/i.test(item.codec || '') ? 1 : 0,
        known && Number.isFinite(item.bitrate) && item.bitrate > 0 ? item.bitrate : 0];
    };
    const compare = (a, b) => { const x = score(a.audio), y = score(b.audio); for (let n = 0; n < x.length; n++) if (x[n] !== y[n]) return y[n] - x[n]; return 0; };
    candidates.sort(compare);
    if (!score(candidates[0].audio)[0]) return {audio: null, reason: 'ambiguous'};
    const best = candidates.filter(candidate => compare(candidate, candidates[0]) === 0);
    const group = value(best[0].audio.audioGroup);
    if (best.length !== 1 && (!group || best.some(candidate => candidate.audio.audioGroup !== group))) return {audio: null, reason: 'ambiguous'};
    return {...best[0], reason: 'matched'};
  }
  function findPairs(items) {
    const pairs = [], rows = items.map(item => ({item, ...classify(item)}));
    for (const {item: video} of rows.filter(row => row.track === 'video')) {
      const selected = findAudio(items, video, rows);
      if (selected.audio) pairs.push({video, audio: selected.audio, identity: selected.identity, automatic: true});
    }
    return pairs;
  }
  globalThis.ShiliuPairing = Object.freeze({classify, findAudio, findPairs, isMp4});
})();
