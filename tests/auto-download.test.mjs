import {test} from 'node:test';
import assert from 'node:assert/strict';
import {automaticVideo} from '../extension/auto-download.js';
const info = (...kinds) => ({tracks: kinds.map(kind => ({kind, duration: 8})), duration: 8});
function fixture(videoInfo = info('video'), association = {ok: true, audioId: 'audio'}, audioInfo = info('audio')) {
  const calls = [], video = {name: 'source.mp4'}, audio = {name: 'audio.m4a'}, result = {name: 'merged.mp4'};
  const options = {videoId: 'video', signal: new AbortController().signal,
    receive: async id => { calls.push('receive:' + id); return id === 'video' ? video : audio; },
    inspect: async file => { calls.push('inspect:' + file.name); return file === video ? videoInfo : audioInfo; },
    pair: async id => { calls.push('pair:' + id); return association; },
    merge: async (v, a) => { assert.equal(v, video); assert.equal(a, audio); calls.push('merge'); return result; }};
  return {calls, video, audio, result, options};
}
test('existing picture+sound saves original bytes without pairing, fetching audio or muxing', async () => {
  const f = fixture(info('video', 'audio'));
  const output = await automaticVideo(f.options);
  assert.equal(output.file, f.video); assert.equal(output.merged, false);
  assert.deepEqual(f.calls, ['receive:video', 'inspect:source.mp4']);
});
test('silent video fetches only background-selected audio after inspecting its actual tracks', async () => {
  const f = fixture(), output = await automaticVideo(f.options);
  assert.equal(output.file, f.result); assert.equal(output.merged, true);
  assert.deepEqual(f.calls, ['receive:video','inspect:source.mp4','pair:video','receive:audio','inspect:audio.m4a','merge']);
});
test('missing/ambiguous pair never guesses or downloads a candidate', async () => {
  for (const reason of ['none', 'ambiguous']) {
    const f = fixture(info('video'), {ok: true, audioId: null, reason});
    await assert.rejects(automaticVideo(f.options), /播放目标视频后重新扫描/);
    assert.deepEqual(f.calls, ['receive:video','inspect:source.mp4','pair:video']);
  }
});
test('wrong actual audio tracks or mismatched duration cannot reach merger', async () => {
  for (const audioInfo of [info('video'), info('video','audio'), {tracks: [{kind: 'audio',duration: 30}],duration: 30}]) {
    const f = fixture(info('video'), undefined, audioInfo);
    await assert.rejects(automaticVideo(f.options), /重新扫描/); assert.equal(f.calls.includes('merge'), false);
  }
});
test('cancel after video inspection does not start pairing or audio fetch', async () => {
  const f = fixture(), controller = new AbortController(); f.options.signal = controller.signal;
  f.options.inspect = async () => { controller.abort(); return info('video'); };
  await assert.rejects(automaticVideo(f.options), {name: 'AbortError'});
  assert.deepEqual(f.calls, ['receive:video']);
});
