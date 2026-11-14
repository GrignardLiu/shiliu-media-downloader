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
    const track = queryTrack || (/^(audio|video)\//.exec(mime)?.[1]) ||
      (['audio', 'video'].includes(item.kind) ? item.kind : 'unknown');
    const identities = [];
    // Explicit metadata must describe the actual resource, not the current page.
    for (const [field, key] of [['pairId', 'pair'], ['contentId', 'content'], ['videoId', 'video'], ['awemeId', 'aweme']]) {
      const id = value(item[field]);
      if (id) identities.push(key + ':' + id);
    }
    const douyin = /(^|\.)(douyin\.com|douyinvod\.com)$/.test(url.hostname);
    if (douyin) {
      for (const [field, key] of [['vid', 'video'], ['video_id', 'video'], ['aweme_id', 'aweme']]) {
        const values = url.searchParams.getAll(field);
        if (values.length === 1 && value(values[0])) identities.push(key + ':' + values[0]);
      }
    }
    // file_id identifies a rendition; dash, timestamp, path and tab do not prove identity.
    return {track, identities: [...new Set(identities)]};
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
  function findPairs(items) {
    const rows = items.map(item => ({item, ...classify(item)}));
    const candidates = [];
    for (const video of rows.filter(row => row.track === 'video')) {
      for (const audio of rows.filter(row => row.track === 'audio')) {
        if (video.item.url === audio.item.url) continue;
        // Never cross frame/document boundaries, including an unknown boundary on one side.
        if (video.item.frameId !== audio.item.frameId || video.item.documentId !== audio.item.documentId) continue;
        const identity = video.identities.find(id => audio.identities.includes(id));
        if (!identity) continue;
        // Any contradictory identifier of the same type rules out the match.
        const contradictory = video.identities.some(id => {
          const prefix = id.split(':')[0] + ':';
          return audio.identities.some(other => other.startsWith(prefix)) && !audio.identities.includes(id);
        });
        if (!contradictory) candidates.push({video: video.item, audio: audio.item, identity, automatic: true});
      }
    }
    // Ambiguous alternate audio/video renditions require an explicit user selection.
    return candidates.filter(pair => candidates.filter(other => other.video === pair.video || other.audio === pair.audio).length === 1);
  }
  globalThis.ShiliuPairing = Object.freeze({classify, findPairs, isMp4});
})();
