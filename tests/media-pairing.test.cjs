const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const vm = require('node:vm');
const context = {URL};
vm.runInNewContext(readFileSync(require('node:path').join(__dirname, '../extension/media-pairing.js'), 'utf8'), context);
const {classify, findPairs, isMp4} = context.ShiliuPairing;
const row = (kind, query = '', extra = {}) => ({url: `https://v1.douyinvod.com/${kind}.mp4?${query}`, kind, frameId: 0, documentId: 'one', ...extra});
test('same explicit content ID pairs distinct signed resource URLs without modifying originals', () => {
  const video = row('video', 'vid=abc123&sig=exact%2Fbytes');
  const audio = row('audio', 'vid=abc123&sig=other');
  const pair = findPairs([video, audio])[0];
  assert.equal(pair.video, video); assert.equal(pair.audio, audio);
  assert.equal(video.url.endsWith('sig=exact%2Fbytes'), true);
});
test('proximity, shared file_id, DASH and generic hosts cannot prove content identity', () => {
  for (const query of ['', 'file_id=same123', 'dash=1']) assert.equal(findPairs([row('video', query), row('audio', query)]).length, 0);
  assert.equal(findPairs([row('video', 'vid=abc123', {url: 'https://other.test/v?vid=abc123'}), row('audio', 'vid=abc123')]).length, 0);
});
test('adjacent clips, distinct frames, document changes and ambiguous renditions are excluded', () => {
  const video = row('video', 'vid=abc123');
  for (const audio of [row('audio', 'vid=other123'), row('audio', 'vid=abc123', {frameId: 1}), row('audio', 'vid=abc123', {documentId: 'two'})]) assert.equal(findPairs([video, audio]).length, 0);
  assert.equal(findPairs([video, row('audio', 'vid=abc123'), row('audio', 'vid=abc123&alt=1')]).length, 0);
});
test('explicit track MIME query can identify an audio MP4 while contradictory IDs reject pairing', () => {
  assert.equal(classify(row('video', 'mime_type=audio')).track, 'audio');
  assert.equal(findPairs([row('video', 'vid=abc123', {awemeId: '11111'}), row('audio', 'vid=abc123', {awemeId: '22222'})]).length, 0);
  assert.equal(findPairs([row('video', 'vid=abc123&vid=other'), row('audio', 'vid=abc123')]).length, 0);
});
test('Douyin MP4 track hints override generic response MIME and element kind', () => {
  for (const type of ['audio', 'audio_mp4']) assert.equal(classify(row('video', `mime_type=${type}`, {mime: 'video/mp4'})).track, 'audio');
  assert.equal(classify(row('audio', 'mime_type=video_mp4', {mime: 'audio/mp4'})).track, 'video');
});
test('MP4 eligibility accepts containers and track hints while excluding WebM', () => {
  for (const extension of ['mp4', 'm4v', 'm4a']) assert.equal(isMp4({url: 'https://example.test/media', extension}), true);
  for (const mime of ['video/mp4', 'audio/mp4; codecs=mp4a']) assert.equal(isMp4({url: 'https://example.test/media', mime}), true);
  for (const query of ['audio_mp4', 'video_mp4']) assert.equal(isMp4({url: `https://v1.douyinvod.com/media?mime_type=${query}`}), true);
  assert.equal(isMp4({url: 'https://example.test/file.webm', mime: 'video/webm', extension: 'webm'}), false);
  assert.equal(isMp4({url: 'https://example.test/media?mime_type=audio_mp4', mime: 'audio/webm'}), false);
  assert.equal(isMp4({url: 'https://example.test/media'}), false);
});
test('host allowlist rejects suffix lookalikes and unrelated CDN vid parameters', () => {
  for (const host of ['douyinvod.com.evil.test', 'evildouyin.com', 'example.test']) {
    const video = row('video', '', {url: `https://${host}/v?vid=abc123`});
    const audio = row('audio', '', {url: `https://${host}/a?vid=abc123`});
    assert.equal(findPairs([video, audio]).length, 0);
  }
});

test('multiple video qualities share a single reliable audio without inverse ambiguity', () => {
  const video=row('video','vid=abc123&quality=1080');
  const low=row('video','vid=abc123&quality=480');
  const audio=row('audio','vid=abc123');
  const pairs=findPairs([video,low,audio]);
  assert.equal(pairs.length,2);assert.ok(pairs.every(pair=>pair.audio===audio));
});

test('owning-video audio metadata ranks AAC quality and backs off on unresolved track ties', () => {
  const video=row('video','vid=abc123');
  const meta={evidence:'douyin-video-object',codec:'aac',awemeId:'clip123'};
  video.awemeId='clip123';
  const low=row('audio','vid=abc123&audio=low',{...meta,bitrate:64000,audioGroup:'track-low'});
  const high=row('audio','vid=abc123&audio=high',{...meta,bitrate:128000,audioGroup:'track-high'});
  assert.equal(findPairs([video,low,high])[0].audio,high);
  const backup=row('audio','vid=abc123&audio=backup',{...meta,bitrate:128000,audioGroup:'track-high'});
  assert.equal(findPairs([video,low,high,backup])[0].audio,high);
  backup.audioGroup='different-track';
  assert.equal(findPairs([video,high,backup]).length,0);
  const other=row('audio','vid=abc123&audio=wrong',{...meta,awemeId:'other123',bitrate:256000});
  assert.equal(findPairs([video,high,other])[0].audio,high);
});

test('identifier contradictions are symmetric and metadata role beats generic video MIME', () => {
  const video=row('video','vid=abc123&video_id=abc123');
  const bad=row('audio','vid=abc123&video_id=other123');
  assert.equal(findPairs([video,bad]).length,0);
  const audio=row('video','vid=abc123',{mime:'video/mp4',metadataTrack:'audio',evidence:'douyin-video-object'});
  assert.equal(classify(audio).track,'audio');assert.equal(findPairs([video,audio]).length,1);
  audio.associationConflict=true;assert.equal(findPairs([video,audio]).length,0);
});

test('literal same-owner metadata overrides rendition vid while different owners cannot share audio', () => {
  const metadata={evidence:'douyin-video-object',pairId:'owner123',awemeId:'owner123',contentId:'owner123'};
  const video=row('video','vid=video-rendition',metadata);
  const audio=row('audio','vid=audio-rendition',metadata);
  assert.equal(findPairs([video,audio])[0].audio,audio);
  audio.awemeId='other123';audio.pairId='other123';audio.contentId='other123';
  audio.url=video.url.replace('/video.mp4','/audio.mp4');
  assert.equal(findPairs([video,audio]).length,0);
});
