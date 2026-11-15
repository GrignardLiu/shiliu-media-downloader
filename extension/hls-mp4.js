// Finalize streamed HLS fMP4 headers without buffering or rewriting media payloads.
const MAX_METADATA = 32 * 1024 ** 2;
const fail = message => { throw new Error("无法完成 MP4 时长信息：" + message); };
const check = signal => signal?.throwIfAborted();
function view(bytes) { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
function u32(bytes, at) { return view(bytes).getUint32(at); }
function u64(bytes, at) {
  const value = Number(view(bytes).getBigUint64(at));
  if (!Number.isSafeInteger(value)) fail("时间或偏移超出安全范围。");
  return value;
}
function i64(bytes, at) {
  const value = Number(view(bytes).getBigInt64(at));
  if (!Number.isSafeInteger(value)) fail("编辑时间超出安全范围。");
  return value;
}
function boxes(bytes, start = 0, end = bytes.length) {
  const result = [];
  for (let at = start; at < end;) {
    if (at + 8 > end || result.length > 4096) fail("索引结构不完整或过于复杂。");
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    let size = u32(bytes, at), header = size === 1 ? 16 : 8;
    if (at + header > end) fail("扩展索引头不完整。");
    size = size === 1 ? u64(bytes, at + 8) : size || end - at;
    if (size < header || size > end - at) fail("索引长度无效。");
    result.push({type, start: at, data: at + header, end: at + size}); at += size;
  }
  return result;
}
function only(bytes, parent, type) {
  const matches = boxes(bytes, parent.data, parent.end).filter(box => box.type === type);
  if (matches.length !== 1) fail("缺少唯一的 " + type + " 索引。");
  return matches[0];
}
async function* topBoxes(blob, signal) {
  let count = 0;
  for (let at = 0; at < blob.size;) {
    check(signal);
    if (++count > 4096) fail("片段索引过于复杂。");
    const bytes = new Uint8Array(await blob.slice(at, Math.min(at + 16, blob.size)).arrayBuffer());
    if (bytes.length < 8) fail("片段头不完整。");
    const type = String.fromCharCode(...bytes.subarray(4, 8));
    let size = u32(bytes, 0), header = size === 1 ? 16 : 8;
    if (bytes.length < header) fail("扩展片段头不完整。");
    size = size === 1 ? u64(bytes, 8) : size || blob.size - at;
    if (size < header || size > blob.size - at) fail("片段长度无效。");
    yield {type, start: at, data: at + header, end: at + size}; at += size;
  }
}
function clock(bytes, box, kind) {
  const version = bytes[box.data];
  if (version > 1) fail("不支持的时间字段版本。");
  const scaleAt = box.data + (version ? 20 : 12);
  const at = kind === "track" ? box.data + (version ? 28 : 20) : scaleAt + 4;
  const width = version ? 8 : 4;
  if (at + width > box.end) fail("时间字段不完整。");
  const scale = kind === "track" ? null : u32(bytes, scaleAt);
  if (kind !== "track" && !scale) fail("时间基准为零。");
  return {at, width, scale};
}
function integerBytes(value, width) {
  if (!Number.isSafeInteger(value) || value < 0 || (width === 4 && value > 0xffffffff)) fail("时长超出当前文件头范围，请使用 FFmpeg 保存。");
  const bytes = new Uint8Array(width);
  if (width === 8) view(bytes).setBigUint64(0, BigInt(value)); else view(bytes).setUint32(0, value);
  return bytes;
}
/** Observe each media fragment, then patch small duration fields before closing the native writable. */
export async function createHlsMp4Finalizer(init, signal) {
  let source;
  for await (const box of topBoxes(init, signal)) if (box.type === "moov") {
    if (source || box.end - box.start > MAX_METADATA) fail("初始化索引重复或超过 32 MiB。");
    source = {offset: box.start, bytes: new Uint8Array(await init.slice(box.start, box.end).arrayBuffer())};
  }
  check(signal);
  if (!source) fail("缺少 moov 初始化索引。");
  const {bytes, offset} = source, root = boxes(bytes)[0], movie = clock(bytes, only(bytes, root, "mvhd"), "movie");
  const tracks = new Map(); let editCount = 0;
  for (const trak of boxes(bytes, root.data, root.end).filter(box => box.type === "trak")) {
    check(signal);
    const tkhd = only(bytes, trak, "tkhd"), media = only(bytes, trak, "mdia");
    const trackClock = clock(bytes, tkhd, "track"), mediaClock = clock(bytes, only(bytes, media, "mdhd"), "media");
    const id = u32(bytes, tkhd.data + (bytes[tkhd.data] ? 20 : 12));
    if (!id || tracks.has(id)) fail("轨道编号重复或无效。");
    const editContainer = boxes(bytes, trak.data, trak.end).find(box => box.type === "edts");
    const edits = [];
    if (editContainer) {
      const elst = only(bytes, editContainer, "elst"), version = bytes[elst.data], width = version ? 8 : 4, stride = version ? 20 : 12;
      if (version > 1 || elst.data + 8 > elst.end) fail("编辑列表格式无效。");
      const count = u32(bytes, elst.data + 4);
      editCount += count;
      if (editCount > 4096) fail("编辑列表条目过多。");
      if (elst.data + 8 + count * stride !== elst.end) fail("编辑列表不完整。");
      for (let n = 0; n < count; n++) {
        const at = elst.data + 8 + n * stride, rateAt = at + width * 2;
        if (view(bytes).getInt16(rateAt) !== 1 || view(bytes).getInt16(rateAt + 2) !== 0) fail("暂不支持变速编辑列表。");
        edits.push({at, width, duration: width === 8 ? u64(bytes, at) : u32(bytes, at), mediaTime: width === 8 ? i64(bytes, at + width) : view(bytes).getInt32(at + width)});
      }
    }
    tracks.set(id, {trackClock, mediaClock, edits, defaultDuration: 0, decodeEnd: 0, presentationEnd: 0, samples: 0});
  }
  if (!tracks.size) fail("初始化索引没有轨道。");
  const mvex = only(bytes, root, "mvex");
  for (const trex of boxes(bytes, mvex.data, mvex.end).filter(box => box.type === "trex")) {
    if (trex.end - trex.data !== 24) fail("分片默认值不完整。");
    const track = tracks.get(u32(bytes, trex.data + 4));
    if (track) track.defaultDuration = u32(bytes, trex.data + 12);
  }
  return {
    async observe(blob, activeSignal = signal) {
      for await (const box of topBoxes(blob, activeSignal)) {
        if (box.type !== "moof") continue;
        if (box.end - box.start > MAX_METADATA) fail("分片索引超过 32 MiB。");
        const data = new Uint8Array(await blob.slice(box.start, box.end).arrayBuffer()), moof = boxes(data)[0];
        for (const traf of boxes(data, moof.data, moof.end).filter(child => child.type === "traf")) {
          check(activeSignal);
          const tfhd = only(data, traf, "tfhd");
          if (tfhd.data + 8 > tfhd.end || data[tfhd.data] !== 0) fail("分片轨道头不完整。");
          const flags = u32(data, tfhd.data) & 0xffffff, track = tracks.get(u32(data, tfhd.data + 4));
          if (!track) fail("分片引用了未知轨道。");
          let at = tfhd.data + 8 + (flags & 1 ? 8 : 0) + (flags & 2 ? 4 : 0), defaultDuration = track.defaultDuration;
          if (flags & 8) { if (at + 4 > tfhd.end) fail("分片默认时长不完整。"); defaultDuration = u32(data, at); }
          const tfdt = only(data, traf, "tfdt"), version = data[tfdt.data];
          if (version > 1 || tfdt.end - tfdt.data !== (version ? 12 : 8)) fail("分片解码时间无效。");
          let dts = version ? u64(data, tfdt.data + 4) : u32(data, tfdt.data + 4);
          for (const run of boxes(data, traf.data, traf.end).filter(child => child.type === "trun")) {
            if (run.data + 8 > run.end || data[run.data] > 1) fail("分片样本时间表不完整。");
            const mask = u32(data, run.data) & 0xffffff, count = u32(data, run.data + 4), signed = data[run.data] === 1;
            let pos = run.data + 8 + (mask & 1 ? 4 : 0) + (mask & 4 ? 4 : 0);
            const stride = [256,512,1024,2048].filter(flag => mask & flag).length * 4;
            if (pos + count * stride !== run.end || count > 10000000 || (!(mask & 256) && !defaultDuration && count)) fail("分片样本时长无效。");
            track.samples += count;
            // A duration-only default run does not need per-sample work.
            if (!(mask & (256 | 2048))) {
              dts += count * defaultDuration;
              track.presentationEnd = Math.max(track.presentationEnd, dts);
            } else for (let n = 0; n < count; n++) {
              const duration = mask & 256 ? u32(data, pos) : defaultDuration;
              const compositionAt = pos + (mask & 256 ? 4 : 0) + (mask & 512 ? 4 : 0) + (mask & 1024 ? 4 : 0);
              const composition = mask & 2048 ? (signed ? view(data).getInt32(compositionAt) : u32(data, compositionAt)) : 0;
              track.presentationEnd = Math.max(track.presentationEnd, dts + composition + duration);
              dts += duration; pos += stride;
            }
            if (!Number.isSafeInteger(dts) || !Number.isSafeInteger(track.presentationEnd)) fail("样本时间超出安全范围。");
          }
          track.decodeEnd = Math.max(track.decodeEnd, dts);
        }
      }
    },
    async finalize(writable, activeSignal = signal) {
      const patches = []; let movieDuration = 0;
      const patch = (field, value) => patches.push({type: "write", position: offset + field.at, data: integerBytes(value, field.width)});
      for (const track of tracks.values()) {
        if (!track.samples) continue;
        const mediaScale = track.mediaClock.scale;
        let duration = Math.ceil(track.presentationEnd * movie.scale / mediaScale);
        if (track.edits.length) {
          duration = 0;
          for (const edit of track.edits) {
            let segment = edit.duration;
            if (!segment && edit.mediaTime >= 0) {
              segment = Math.max(0, Math.ceil((track.presentationEnd - edit.mediaTime) * movie.scale / mediaScale));
              patch(edit, segment);
            }
            duration += segment;
          }
        }
        patch(track.mediaClock, track.decodeEnd); patch(track.trackClock, duration);
        movieDuration = Math.max(movieDuration, duration);
      }
      if (!movieDuration) fail("没有可用的媒体样本。");
      patch(movie, movieDuration);
      // Validate every value before the first write; callers roll back if any write fails.
      for (const operation of patches) { check(activeSignal); await writable.write(operation); }
      check(activeSignal);
      return {duration: movieDuration / movie.scale};
    }
  };
}

