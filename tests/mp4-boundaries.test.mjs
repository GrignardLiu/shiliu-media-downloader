import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile, writeFile, mkdir, mkdtemp} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {mergeMp4} from '../extension/mp4-merge.js';
const available = ['ffmpeg', 'ffprobe'].every(command => spawnSync(command, ['-version']).status === 0);
const run = (command, args) => { const r = spawnSync(command, args, {encoding: 'utf8'}); assert.equal(r.status, 0, r.stderr); return r.stdout; };
const table = (bytes, name) => { const at = bytes.indexOf(Buffer.from(name)); assert.ok(at >= 4, name); return at; };
const pts = path => JSON.parse(run('ffprobe', ['-v','error','-select_streams','a','-show_entries','packet=pts_time','-of','json',path])).packets.map(p => p.pts_time);

// Sparse Blob semantics: payload padding is represented by length, never allocated.
// All parsing and output-address reads use the same slice/arrayBuffer API as File.
class Zero {
  constructor(size) { this.size = size; }
  slice(start, end) { return new Zero(end - start); }
  async arrayBuffer() { assert.ok(this.size <= 32 * 1024 * 1024); return new ArrayBuffer(this.size); }
}
class SparseBlob {
  constructor(parts = []) {
    this.parts = parts.map(part => part instanceof Uint8Array ? new NativeBlob([part]) : part);
    this.size = this.parts.reduce((size, part) => size + part.size, 0);
  }
  slice(start = 0, end = this.size) {
    start = Math.min(this.size, Math.max(0, start)); end = Math.min(this.size, Math.max(start, end));
    let at = 0; const parts = [];
    for (const part of this.parts) {
      const lo = Math.max(start, at), hi = Math.min(end, at + part.size);
      if (hi > lo) parts.push(part.slice(lo - at, hi - at)); at += part.size;
    }
    return new SparseBlob(parts);
  }
  async arrayBuffer() {
    assert.ok(this.size <= 32 * 1024 * 1024, 'test must not allocate sparse media');
    const bytes = new Uint8Array(this.size); let at = 0;
    for (const part of this.parts) { bytes.set(new Uint8Array(await part.arrayBuffer()), at); at += part.size; }
    return bytes.buffer;
  }
}
const NativeBlob = globalThis.Blob;

test('MP4 boundary regressions', {skip: !available}, async t => {
  await mkdir(resolve('work'), {recursive: true}); const dir = await mkdtemp(join(resolve('work'), 'mp4-boundaries-'));
  const v = join(dir, 'video.mp4'), a = join(dir, 'audio.mp4'), out = join(dir, 'out.mp4');
  run('ffmpeg', ['-v','error','-f','lavfi','-i','testsrc=size=64x64:rate=10:duration=2','-an','-c:v','libx264','-pix_fmt','yuv420p','-movie_timescale','1','-y',v]);
  run('ffmpeg', ['-v','error','-itsoffset','0.3','-f','lavfi','-i','sine=frequency=440:duration=1.7','-vn','-c:a','aac','-movie_timescale','90000','-y',a]);
  const video = await readFile(v), audio = await readFile(a), vb = new Blob([video]), ab = new Blob([audio]);
  await t.test('preserves low movie-timescale delayed edits and packet PTS', async () => {
  const merged = await mergeMp4(vb, ab); await writeFile(out, new Uint8Array(await merged.arrayBuffer()));
  assert.deepEqual(pts(out), pts(a)); run('ffmpeg', ['-v','error','-i',out,'-f','null','-']);
  const bytes = await readFile(out), mvhd = table(bytes, 'mvhd'); assert.equal(bytes[mvhd + 4], 1); assert.equal(bytes.readUInt32BE(mvhd + 24), 90000);
  });
  await t.test('rejects progressive sample extent/count corruption and unsupported stz2', async () => {
  const badSize = Buffer.from(video); badSize.writeUInt32BE(0xffffff, table(badSize, 'stsz') + 16);
  await assert.rejects(mergeMp4(new Blob([badSize]), ab), /完整范围/);
  const badCount = Buffer.from(video), stts = table(badCount, 'stts'); badCount.writeUInt32BE(badCount.readUInt32BE(stts + 12) + 1, stts + 12);
  await assert.rejects(mergeMp4(new Blob([badCount]), ab), /数量不一致/);
  const compact = Buffer.from(video); compact.write('stz2', table(compact, 'stsz'));
  await assert.rejects(mergeMp4(new Blob([compact]), ab), /stz2/);
  });
  const moovAt = table(video, 'moov') - 4;
  await t.test('bounds child boxes and rejects oversized promotions before rebuilding metadata', async () => {
  const padding = Buffer.alloc(10001 * 8);
  for (let i = 0; i < 10001; i++) { padding.writeUInt32BE(8, i * 8); padding.write('free', i * 8 + 4); }
  const bomb = Buffer.concat([video, padding]); bomb.writeUInt32BE(video.readUInt32BE(moovAt) + padding.length, moovAt);
  await assert.rejects(mergeMp4(new Blob([bomb]), ab), /子盒数量/);
  const expandedTable = (name, count, stride, parents, countOffset) => {
    const at = table(video, name) - 4, oldSize = video.readUInt32BE(at), replacement = Buffer.alloc(16 + count * stride);
    replacement.writeUInt32BE(replacement.length); replacement.write(name, 4); replacement.writeUInt32BE(count, countOffset);
    const bytes = Buffer.concat([video.subarray(0, at), replacement, video.subarray(at + oldSize)]), growth = replacement.length - oldSize;
    for (const parent of parents) { const start = table(video, parent) - 4; bytes.writeUInt32BE(video.readUInt32BE(start) + growth, start); }
    return bytes;
  };
  // Each source moov remains <32 MiB; widening just this table would exceed
  // the limit. These must fail in prepare's projection, before table rebuilds.
  const wideOffsets = expandedTable('stco', 4500000, 4, ['stbl','minf','mdia','trak','moov'], 12);
  await assert.rejects(mergeMp4(new Blob([wideOffsets]), ab), /提升后的索引/);
  const wideEdits = expandedTable('elst', 1700000, 12, ['edts','trak','moov'], 12);
  await assert.rejects(mergeMp4(new Blob([wideEdits]), ab), /提升后的索引/);

  });
  await t.test('promotes stco to co64 and preserves sparse sample addresses beyond 4 GiB', async () => {
  const mdatAt = table(video, 'mdat') - 4, mdatSize = video.readUInt32BE(mdatAt), moov = Buffer.from(video.subarray(moovAt));
  const stco = table(moov, 'stco'), count = moov.readUInt32BE(stco + 8), originalFirst = moov.readUInt32BE(stco + 12);
  for (let n = 0; n < count; n++) moov.writeUInt32BE(moov.readUInt32BE(stco + 12 + n * 4) + 8, stco + 12 + n * 4);
  const largeSize = 0x100000100, head = Buffer.alloc(16); head.writeUInt32BE(1); head.write('mdat', 4); head.writeBigUInt64BE(BigInt(largeSize), 8);
  const sparseVideo = new SparseBlob([video.subarray(0, mdatAt), head, video.subarray(mdatAt + 8, mdatAt + mdatSize), new Zero(largeSize - 16 - (mdatSize - 8)), moov]);
  let sparseOut;
  try { globalThis.Blob = SparseBlob; sparseOut = await mergeMp4(sparseVideo, new NativeBlob([audio])); }
  finally { globalThis.Blob = NativeBlob; }
  assert.ok(sparseOut.size > 0x100000000);
  const prefix = Buffer.from(await sparseOut.slice(0, 65536).arrayBuffer()), firstCo64 = table(prefix, 'co64'), secondCo64 = prefix.indexOf(Buffer.from('co64'), firstCo64 + 4);
  assert.ok(secondCo64 > firstCo64);
  const videoOffset = Number(prefix.readBigUInt64BE(firstCo64 + 12)), audioOffset = Number(prefix.readBigUInt64BE(secondCo64 + 12));
  assert.ok(audioOffset > 0xffffffff);
  assert.deepEqual(Buffer.from(await sparseOut.slice(videoOffset, videoOffset + 32).arrayBuffer()), video.subarray(originalFirst, originalFirst + 32));
  const originalAudio = audio.readUInt32BE(table(audio, 'stco') + 12);
  assert.deepEqual(Buffer.from(await sparseOut.slice(audioOffset, audioOffset + 32).arrayBuffer()), audio.subarray(originalAudio, originalAudio + 32));
  });
});
