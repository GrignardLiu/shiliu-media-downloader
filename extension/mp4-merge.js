// Lossless ISO BMFF muxing. Media payloads remain Blob slices; only bounded moov/moof metadata is read.
const MAX_METADATA = 32 * 1024 * 1024;
const decoder = new TextDecoder("latin1");
const fail = message => { throw new Error(`无法合并 MP4：${message}`); };
function check(signal) { if (signal?.aborted) throw new DOMException("操作已取消", "AbortError"); }
function u32(bytes, at) { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(at); }
function put32(bytes, at, value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) fail("数值超出普通 MP4 范围，请使用 FFmpeg 合并。");
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(at, value);
}
function u64(bytes, at) {
  const value = u32(bytes, at) * 4294967296 + u32(bytes, at + 4);
  if (!Number.isSafeInteger(value)) fail("文件偏移超出安全范围。");
  return value;
}
function put64(bytes, at, value) { put32(bytes, at, Math.floor(value / 4294967296)); put32(bytes, at + 4, value % 4294967296); }
function header(bytes, at, end) {
  if (end - at < 8) fail("文件结构不完整。");
  const type = decoder.decode(bytes.subarray(at + 4, at + 8));
  let size = u32(bytes, at), head = 8;
  if (size === 1) { if (end - at < 16) fail("扩展头不完整。"); size = u64(bytes, at + 8); head = 16; }
  else if (size === 0) size = end - at;
  if (size < head || size > end - at) fail("文件盒长度无效或文件已截断。");
  return {type, start: at, size, head, data: at + head, end: at + size};
}
function boxes(bytes, start = 0, end = bytes.length) {
  const result = [];
  for (let at = start; at < end;) { const box = header(bytes, at, end); result.push(box); at = box.end; }
  return result;
}
function child(bytes, parent, type) { return boxes(bytes, parent.data, parent.end).find(box => box.type === type) || fail(`缺少 ${type} 数据。`); }
function clock(bytes, box, kind) {
  const version = bytes[box.data];
  if (version > 1) fail("不支持此时间字段版本。");
  const scaleAt = box.data + (version ? 20 : 12);
  const durationAt = kind === "tkhd" ? box.data + (version ? 28 : 20) : scaleAt + 4;
  if (durationAt + (version ? 8 : 4) > box.end) fail("时间字段不完整。");
  return {version, scale: kind === "tkhd" ? null : u32(bytes, scaleAt), duration: version ? u64(bytes, durationAt) : u32(bytes, durationAt), durationAt};
}
function setDuration(bytes, info, value) { (info.version ? put64 : put32)(bytes, info.durationAt, value); }
async function inspect(blob, signal) {
  if (!blob || typeof blob.slice !== "function" || !Number.isSafeInteger(blob.size) || blob.size < 8) fail("请选择完整的 MP4 文件。");
  const top = [];
  for (let at = 0; at < blob.size;) {
    check(signal);
    const bytes = new Uint8Array(await blob.slice(at, Math.min(blob.size, at + 16)).arrayBuffer());
    if (bytes.length < 8) fail("文件头不完整。");
    let size = u32(bytes, 0), head = size === 1 ? 16 : 8;
    if (head === 16 && bytes.length < 16) fail("扩展文件头不完整。");
    size = size === 1 ? u64(bytes, 8) : size || blob.size - at;
    if (size < head || size > blob.size - at) fail("文件已截断或格式无效。");
    top.push({type: decoder.decode(bytes.subarray(4, 8)), start: at, size, head, data: at + head, end: at + size});
    if (top.length > 10000) fail("文件结构过于复杂。");
    at += size;
  }
  const fragmented = top.some(box => ["moof", "mfra"].includes(box.type));

  const moovs = top.filter(box => box.type === "moov");
  const mdats = top.filter(box => box.type === "mdat");
  if (moovs.length !== 1 || !mdats.length) fail("需要包含 moov 和 mdat 的完整 MP4 文件。");
  if (moovs[0].size > MAX_METADATA) fail("索引超过 32 MB，请使用 FFmpeg 合并。");
  const bytes = new Uint8Array(await blob.slice(moovs[0].start, moovs[0].end).arrayBuffer());
  const moov = header(bytes, 0, bytes.length);
  const children = boxes(bytes, moov.data, moov.end);

  const mvhd = child(bytes, moov, "mvhd");
  const timing = clock(bytes, mvhd, "mvhd");
  if (!timing.scale) fail("时间基准无效。");
  const source = {blob, top, mdats, bytes, moov, mvhd, timing, fragmented: fragmented || children.some(box => box.type === "mvex"), tracks: children.filter(box => box.type === "trak")};
  source.fragmentEnds = source.fragmented ? await fragmentTiming(source, signal) : new Map();
  return source;
}
function select(source, kind) {
  const matches = source.tracks.filter(track => {
    const hdlr = child(source.bytes, child(source.bytes, track, "mdia"), "hdlr");
    if (hdlr.data + 12 > hdlr.end) fail("轨道头不完整。");
    return decoder.decode(source.bytes.subarray(hdlr.data + 8, hdlr.data + 12)) === kind;
  });
  if (matches.length !== 1) fail(`文件需要恰好一条${kind === "vide" ? "视频" : "音频"}轨道。`);
  return matches[0];
}
function rewrite(source, track, id, scale, locations) {
  const bytes = source.bytes.slice(track.start, track.end), root = header(bytes, 0, bytes.length);
  const tkhd = child(bytes, root, "tkhd"), timing = clock(bytes, tkhd, "tkhd");
  put32(bytes, tkhd.data + (timing.version ? 20 : 12), id);
  const convert = value => Math.round(value * scale / source.timing.scale);
  const duration = Math.round(presentationDuration(source, track) * scale);
  setDuration(bytes, timing, duration);
  const trackChildren = boxes(bytes, root.data, root.end);
  if (trackChildren.some(box => box.type === "tref")) fail("带轨道引用的文件需要使用 FFmpeg 合并。");
  const edts = trackChildren.find(box => box.type === "edts");
  if (edts) {
    const elst = child(bytes, edts, "elst"), version = bytes[elst.data];
    if (version > 1 || elst.data + 8 > elst.end) fail("编辑列表格式无效。");
    const count = u32(bytes, elst.data + 4), stride = version ? 20 : 12;
    if (count > (elst.end - elst.data - 8) / stride || elst.data + 8 + count * stride !== elst.end) fail("编辑列表不完整。");
    for (let n = 0; n < count; n++) { const at = elst.data + 8 + n * stride; (version ? put64 : put32)(bytes, at, convert(version ? u64(bytes, at) : u32(bytes, at))); }
  }
  const minf = child(bytes, child(bytes, root, "mdia"), "minf");
  const dref = child(bytes, child(bytes, minf, "dinf"), "dref");
  if (dref.data + 8 > dref.end) fail("数据引用不完整。");
  const refs = boxes(bytes, dref.data + 8, dref.end);
  if (!refs.length || refs.some(ref => ref.type !== "url " || ref.data + 4 > ref.end || !(u32(bytes, ref.data) & 1))) fail("不支持引用外部文件的 MP4。");
  const stbl = child(bytes, minf, "stbl"), tables = boxes(bytes, stbl.data, stbl.end);
  const stsd = child(bytes, stbl, "stsd");
  if (stsd.data + 8 > stsd.end) fail("编码信息不完整。");
  const entries = boxes(bytes, stsd.data + 8, stsd.end);
  const allowed = id === 1 ? ["avc1", "avc3", "hvc1", "hev1", "vp09", "av01", "mp4v"] : ["mp4a", "Opus", "ac-3", "ec-3", "alac", "fLaC"];
  if (!entries.length || entries.some(entry => !allowed.includes(entry.type))) fail("编码不受支持或轨道已加密，请使用 FFmpeg 检查文件。");
  if (tables.some(box => ["saio", "saiz", "senc"].includes(box.type))) fail("不支持加密轨道。");
  const offsets = tables.filter(box => ["stco", "co64"].includes(box.type));
  if (offsets.length !== 1) fail("缺少唯一的媒体偏移表。");
  const offsetsBox = offsets[0], wide = offsetsBox.type === "co64", stride = wide ? 8 : 4;
  if (offsetsBox.data + 8 > offsetsBox.end) fail("媒体偏移表不完整。");
  const count = u32(bytes, offsetsBox.data + 4);
  if (offsetsBox.data + 8 + count * stride !== offsetsBox.end) fail("媒体偏移表长度无效。");
  for (let n = 0; n < count; n++) {
    const at = offsetsBox.data + 8 + n * stride, old = wide ? u64(bytes, at) : u32(bytes, at);
    const media = locations.find(location => old >= location.original.data && old < location.original.end);
    if (!media) fail("媒体偏移指向文件数据范围之外。");
    (wide ? put64 : put32)(bytes, at, media.start + old - media.original.start);
  }
  return {bytes, duration};
}
function container(type, parts) {
  const size = 8 + parts.reduce((sum, part) => sum + part.length, 0), bytes = new Uint8Array(size);
  put32(bytes, 0, size); bytes.set(new TextEncoder().encode(type), 4);
  let at = 8; for (const part of parts) { bytes.set(part, at); at += part.length; }
  return bytes;
}
/** Merge one video track and one audio track without decoding; timestamps/edit lists are preserved. */
export async function mergeMp4(videoBlob, audioBlob, {signal, onProgress} = {}) {
  check(signal); onProgress?.({stage: "inspect", progress: 0});
  const video = await flatten(await inspect(videoBlob, signal), "vide", signal), audio = await flatten(await inspect(audioBlob, signal), "soun", signal);
  check(signal);
  const videoTrack = select(video, "vide"), audioTrack = select(audio, "soun");
  // Explicit brands avoid inheriting audio-only or source-specific compatibility claims.
  const ftyp = container("ftyp", [new Uint8Array([105,115,111,109,0,0,2,0,105,115,111,109,105,115,111,50,109,112,52,49])]);
  const moovLength = 8 + video.mvhd.size + videoTrack.size + audioTrack.size;
  if (moovLength > MAX_METADATA) fail("合并后的索引超过 32 MB，请使用 FFmpeg 合并。");
  const parts = [ftyp], locations = new Map(); let position = ftyp.length + moovLength;
  for (const source of [video, audio]) {
    const list = []; locations.set(source, list);
    for (const original of source.mdats) {
      check(signal);
      // Bounded extended-size headers also make source size-zero mdats safe.
      const head = new Uint8Array(16); put32(head, 0, 1); head.set([109,100,97,116], 4); put64(head, 8, original.size - original.head + 16);
      list.push({original, start: position + 16 - original.head});
      parts.push(head, source.blob.slice(original.data, original.end)); position += 16 + original.size - original.head;
    }
  }
  onProgress?.({stage: "index", progress: 0.5});
  const scale = video.timing.scale;
  const v = rewrite(video, videoTrack, 1, scale, locations.get(video));
  const a = rewrite(audio, audioTrack, 2, scale, locations.get(audio));
  const mvhd = video.bytes.slice(video.mvhd.start, video.mvhd.end), box = header(mvhd, 0, mvhd.length);
  setDuration(mvhd, clock(mvhd, box, "mvhd"), Math.max(v.duration, a.duration));
  if (mvhd.length < (box.data + (mvhd[box.data] ? 112 : 100))) fail("电影头不完整。");
  put32(mvhd, mvhd.length - 4, 3);
  parts.splice(1, 0, container("moov", [mvhd, v.bytes, a.bytes]));
  check(signal); const result = new Blob(parts, {type: "video/mp4"});
  onProgress?.({stage: "complete", progress: 1}); check(signal); return result;
}
/** Read bounded metadata for the manual merger's input classification. */
export async function inspectMp4(blob, {signal} = {}) {
  const source = await inspect(blob, signal);
  const tracks = source.tracks.map(track => {
    const mdia = child(source.bytes, track, "mdia"), handler = child(source.bytes, mdia, "hdlr");
    const code = decoder.decode(source.bytes.subarray(handler.data + 8, handler.data + 12));
    const stsd = child(source.bytes, child(source.bytes, child(source.bytes, mdia, "minf"), "stbl"), "stsd");
    return {kind: code === "vide" ? "video" : code === "soun" ? "audio" : code,
      duration: presentationDuration(source, track),
      durationKnown: presentationDuration(source, track) > 0,
      codecs: boxes(source.bytes, stsd.data + 8, stsd.end).map(entry => entry.type)};
  });
  check(signal); return {tracks, fragmented: source.fragmented, duration: Math.max(...tracks.map(track => track.duration)), durationKnown: tracks.every(track => track.durationKnown)};
}


function trackId(source, track) {
  const tkhd = child(source.bytes, track, "tkhd");
  return u32(source.bytes, tkhd.data + (source.bytes[tkhd.data] ? 20 : 12));
}
// Read sample timing without retaining fragment metadata or reading media bytes.
async function fragmentTiming(source, signal) {
  const ends = new Map(), decodeEnds = new Map(), defaults = new Map();
  const mvex = boxes(source.bytes, source.moov.data, source.moov.end).find(box => box.type === "mvex");
  if (mvex) for (const box of boxes(source.bytes, mvex.data, mvex.end).filter(box => box.type === "trex")) {
    if (box.end - box.data !== 24) fail("分片默认值格式无效。");
    defaults.set(u32(source.bytes, box.data + 4), u32(source.bytes, box.data + 12));
  }
  for (const track of source.tracks) {
    const mdhd = clock(source.bytes, child(source.bytes, child(source.bytes, track, "mdia"), "mdhd"), "mdhd");
    decodeEnds.set(trackId(source, track), mdhd.duration);
  }
  let metadata = 0, samples = 0;
  for (const original of source.top.filter(box => box.type === "moof")) {
    check(signal); metadata += original.size;
    if (metadata > MAX_METADATA) fail("分片索引累计超过 32 MB，请使用 FFmpeg 合并。");
    const bytes = new Uint8Array(await source.blob.slice(original.start, original.end).arrayBuffer()), root = header(bytes, 0, bytes.length);
    for (const traf of boxes(bytes, root.data, root.end).filter(box => box.type === "traf")) {
      const items = boxes(bytes, traf.data, traf.end), tfhd = child(bytes, traf, "tfhd");
      if (tfhd.end - tfhd.data < 8) fail("分片头不完整。");
      const flags = u32(bytes, tfhd.data) & 0xffffff, id = u32(bytes, tfhd.data + 4);
      let at = tfhd.data + 8 + (flags & 1 ? 8 : 0) + (flags & 2 ? 4 : 0), duration = defaults.get(id);
      if (flags & 8) { if (at + 4 > tfhd.end) fail("分片默认时长不完整。"); duration = u32(bytes, at); }
      const tfdt = items.find(box => box.type === "tfdt");
      let dts = decodeEnds.get(id) || 0;
      if (tfdt) {
        const version = bytes[tfdt.data];
        if (version > 1 || tfdt.data + (version ? 12 : 8) > tfdt.end) fail("分片时间戳格式无效。");
        dts = version ? u64(bytes, tfdt.data + 4) : u32(bytes, tfdt.data + 4);
      }
      for (const run of items.filter(box => box.type === "trun")) {
        if (run.data + 8 > run.end) fail("分片样本时间表不完整。");
        const version = bytes[run.data], mask = u32(bytes, run.data) & 0xffffff, count = u32(bytes, run.data + 4);
        if (version > 1) fail("分片样本时间版本无效。");
        let pos = run.data + 8 + (mask & 1 ? 4 : 0) + (mask & 4 ? 4 : 0);
        const stride = [256,512,1024,2048].filter(flag => mask & flag).length * 4;
        samples += count;
        if (pos + count * stride !== run.end || samples > 10000000) fail("分片样本表长度无效。");
        if (!(mask & 256) && !duration) fail("分片缺少样本时长。");
        for (let n = 0; n < count; n++) {
          const sampleDuration = mask & 256 ? u32(bytes, pos) : duration;
          let ctoAt = pos + (mask & 256 ? 4 : 0) + (mask & 512 ? 4 : 0) + (mask & 1024 ? 4 : 0);
          const cto = mask & 2048 ? (version ? new DataView(bytes.buffer).getInt32(ctoAt) : u32(bytes, ctoAt)) : 0;
          ends.set(id, Math.max(ends.get(id) || 0, dts + cto + sampleDuration));
          dts += sampleDuration; pos += stride;
          if (!Number.isSafeInteger(dts)) fail("分片时间超出安全范围。");
        }
      }
      decodeEnds.set(id, dts);
    }
  }
  return ends;
}
function presentationDuration(source, track) {
  const id = trackId(source, track), mdia = child(source.bytes, track, "mdia");
  const mdhd = clock(source.bytes, child(source.bytes, mdia, "mdhd"), "mdhd");
  if (!mdhd.scale) fail("轨道时间基准无效。");
  const tkhd = clock(source.bytes, child(source.bytes, track, "tkhd"), "tkhd");
  let seconds = Math.max(mdhd.duration, source.fragmentEnds?.get(id) || 0) / mdhd.scale;
  const edts = boxes(source.bytes, track.data, track.end).find(box => box.type === "edts");
  if (edts) {
    const elst = child(source.bytes, edts, "elst"), version = source.bytes[elst.data], stride = version ? 20 : 12;
    if (version > 1 || elst.data + 8 > elst.end) fail("编辑列表格式无效。");
    const count = u32(source.bytes, elst.data + 4);
    if (elst.data + 8 + count * stride !== elst.end) fail("编辑列表长度无效。");
    // Edit segment durations already describe the movie presentation timeline.
    let edited = 0;
    for (let n = 0; n < count; n++) { const at = elst.data + 8 + n * stride; edited += version ? u64(source.bytes, at) : u32(source.bytes, at); }
    if (edited) seconds = edited / source.timing.scale;
  }
  return Math.max(seconds, tkhd.duration / source.timing.scale);
}


function fullBox(type, fields, version = 0) {
  const payload = new Uint8Array(4 + fields.length); payload[0] = version; payload.set(fields, 4); return container(type, [payload]);
}
function words(values) {
  const bytes = new Uint8Array(values.length * 4); values.forEach((value, index) => put32(bytes, index * 4, value)); return bytes;
}
function replaceChild(bytes, parent, type, replacement) {
  return container(parent.type, boxes(bytes, parent.data, parent.end).flatMap(box => box.type === type ? [replacement] : [bytes.slice(box.start, box.end)]));
}
function compactRuns(values) {
  const runs = [];
  for (const value of values) { const last = runs.at(-1); if (last && last[1] === value) last[0]++; else runs.push([1, value]); }
  return runs;
}
// Flatten fragment timing and sample addresses to conventional MP4 sample tables.
// This avoids mixed/fragmented layouts that Windows Media Foundation may open
// successfully yet expose as an empty stream.
async function flatten(source, kind, signal) {
  if (!source.fragmented) return source;
  const track = select(source, kind), id = trackId(source, track), mdia = child(source.bytes, track, "mdia");
  const minf = child(source.bytes, mdia, "minf"), stbl = child(source.bytes, minf, "stbl"), stsz = child(source.bytes, stbl, "stsz");
  if (stsz.data + 12 > stsz.end || u32(source.bytes, stsz.data + 8)) fail("暂不支持同一轨道混合初始样本与分片，请使用 FFmpeg 合并。");
  const mvex = child(source.bytes, source.moov, "mvex"), trex = boxes(source.bytes, mvex.data, mvex.end).find(box => box.type === "trex" && u32(source.bytes, box.data + 4) === id);
  if (!trex || trex.end - trex.data !== 24) fail("分片默认值不完整。");
  const defaults = {description: u32(source.bytes, trex.data + 8), duration: u32(source.bytes, trex.data + 12), size: u32(source.bytes, trex.data + 16), flags: u32(source.bytes, trex.data + 20)};
  const stsd = child(source.bytes, stbl, "stsd"), descriptions = boxes(source.bytes, stsd.data + 8, stsd.end);
  const sizes = [], durations = [], compositions = [], sync = [], chunks = [];
  let nextDts = 0, metadata = 0;
  for (const original of source.top.filter(box => box.type === "moof")) {
    check(signal); metadata += original.size;
    if (metadata > MAX_METADATA) fail("分片索引累计超过 32 MB，请使用 FFmpeg 合并。");
    const bytes = new Uint8Array(await source.blob.slice(original.start, original.end).arrayBuffer()), root = header(bytes, 0, bytes.length);
    const trafs = boxes(bytes, root.data, root.end).filter(box => box.type === "traf");
    if (trafs.length !== 1) fail("暂不支持单分片多轨道，请使用 FFmpeg 合并。");
    const traf = trafs[0], items = boxes(bytes, traf.data, traf.end), tfhd = child(bytes, traf, "tfhd");
    if (items.filter(box => box.type === "tfhd").length !== 1 || items.filter(box => box.type === "tfdt").length > 1) fail("分片头或解码时间戳重复。");
    if (items.some(box => !["tfhd", "tfdt", "trun", "free"].includes(box.type))) fail("分片包含加密或额外样本元数据，请使用 FFmpeg 合并。");
    if (tfhd.data + 8 > tfhd.end || bytes[tfhd.data] !== 0) fail("分片头格式无效。");
    const mask = u32(bytes, tfhd.data) & 0xffffff;
    if (mask & ~0x03003b) fail("分片头含不支持的标志。");
    if (u32(bytes, tfhd.data + 4) !== id) fail("分片包含额外轨道，请使用 FFmpeg 提取所需轨道。");
    let at = tfhd.data + 8, base = original.start, values = {...defaults};
    if (mask & 1) { if (at + 8 > tfhd.end) fail("分片基地址不完整。"); base = u64(bytes, at); at += 8; }
    for (const [flag, name] of [[2,"description"],[8,"duration"],[16,"size"],[32,"flags"]]) if (mask & flag) {
      if (at + 4 > tfhd.end) fail("分片默认字段不完整。"); values[name] = u32(bytes, at); at += 4;
    }
    if (at !== tfhd.end || !values.description) fail("分片样本描述无效。");
    const tfdt = items.find(box => box.type === "tfdt");
    if (tfdt) {
      const version = bytes[tfdt.data];
      if (version > 1 || tfdt.end - tfdt.data !== (version ? 12 : 8)) fail("分片时间戳无效。");
      const dts = version ? u64(bytes, tfdt.data + 4) : u32(bytes, tfdt.data + 4);
      if (dts !== nextDts) fail("分片解码时间存在间隙、重叠或非零起点，请使用 FFmpeg 合并。");
    }
    for (const run of items.filter(box => box.type === "trun")) {
      if (run.data + 12 > run.end) fail("分片运行表不完整。");
      const flags = u32(bytes, run.data) & 0xffffff, version = bytes[run.data], count = u32(bytes, run.data + 4);
      if (version > 1 || flags & ~0x000f05 || !(flags & 1) || (flags & 4 && flags & 1024)) fail("分片样本标志或数据偏移不受支持。");
      // Bound worst-case generated stts/ctts/stsz/stss/co64/stsc before growing arrays.
      const projectedMetadata = source.bytes.length + 256 + (sizes.length + count) * 24 + (chunks.length + 1) * 20;
      if (sizes.length + count > 1000000 || projectedMetadata > MAX_METADATA) fail("生成的样本索引超过内存上限，请使用 FFmpeg 合并。");
      let pos = run.data + 12;
      const firstFlags = flags & 4 ? (pos + 4 <= run.end ? u32(bytes, pos) : fail("首样本标志不完整。")) : values.flags;
      if (flags & 4) pos += 4;
      const stride = [256,512,1024,2048].filter(flag => flags & flag).length * 4;
      if (pos + count * stride !== run.end) fail("分片样本运行表长度无效。");
      const offset = new DataView(bytes.buffer).getInt32(run.data + 8);
      let address = base + offset, chunkBytes = 0;
      for (let n = 0; n < count; n++) {
        const take = () => { const value = u32(bytes, pos); pos += 4; return value; };
        const duration = flags & 256 ? take() : values.duration;
        const size = flags & 512 ? take() : values.size;
        const sampleFlags = flags & 1024 ? take() : n === 0 ? firstFlags : values.flags;
        let composition = flags & 2048 ? take() : 0;
        if (version === 1 && composition > 0x7fffffff) fail("负组合时间偏移的分片需要使用 FFmpeg 合并，以保持音画时间一致。");
        if (!duration || !size) fail("样本缺少有效时长或大小。");
        durations.push(duration); sizes.push(size); compositions.push(composition);
        if (!(sampleFlags & 0x10000)) sync.push(sizes.length);
        nextDts += duration; chunkBytes += size;
        if (!Number.isSafeInteger(nextDts) || !Number.isSafeInteger(chunkBytes)) fail("样本索引超出安全范围。");
      }
      if (count) {
        const media = source.mdats.find(box => address >= box.data && address + chunkBytes <= box.end);
        if (!media) fail("分片样本范围超出媒体数据。");
        chunks.push({offset: address, count, description: values.description});
      }
    }
  }
  if (!sizes.length) fail("分片轨道没有可用样本。");

  if (chunks.some(chunk => chunk.description > descriptions.length)) fail("样本描述索引超出范围。");
  const tables = [source.bytes.slice(stsd.start, stsd.end)];
  const timeRuns = compactRuns(durations);
  tables.push(fullBox("stts", words([timeRuns.length, ...timeRuns.flat()])));
  if (compositions.some(value => value !== 0)) {
    const runs = compactRuns(compositions), signed = compositions.some(value => value < 0);
    if (signed && compositions.some(value => value > 0x7fffffff)) fail("组合时间偏移超出范围。");
    tables.push(fullBox("ctts", words([runs.length, ...runs.flatMap(([count,value]) => [count,value < 0 ? value + 4294967296 : value])]), signed ? 1 : 0));
  }
  tables.push(fullBox("stsz", words([0, sizes.length, ...sizes])));
  const chunkRuns = [];
  chunks.forEach((chunk,index) => { const prev = chunks[index - 1]; if (!prev || prev.count !== chunk.count || prev.description !== chunk.description) chunkRuns.push(index + 1, chunk.count, chunk.description); });
  tables.push(fullBox("stsc", words([chunkRuns.length / 3, ...chunkRuns])));
  const offsets = new Uint8Array(4 + chunks.length * 8); put32(offsets, 0, chunks.length);
  chunks.forEach((chunk,index) => put64(offsets, 4 + index * 8, chunk.offset));
  tables.push(fullBox("co64", offsets));
  if (kind === "vide" && sync.length !== sizes.length) tables.push(fullBox("stss", words([sync.length, ...sync])));
  const newStbl = container("stbl", tables), newMinf = replaceChild(source.bytes, minf, "stbl", newStbl);
  const newMdia = replaceChild(source.bytes, mdia, "minf", newMinf);
  const mdiaRoot = header(newMdia, 0, newMdia.length), mdhd = child(newMdia, mdiaRoot, "mdhd");
  setDuration(newMdia, clock(newMdia, mdhd, "mdhd"), nextDts);
  const newTrack = replaceChild(source.bytes, track, "mdia", newMdia);
  const newBytes = container("moov", [source.bytes.slice(source.mvhd.start, source.mvhd.end), newTrack]);
  const moov = header(newBytes, 0, newBytes.length);
  return {...source, top: source.top.filter(box => box.type !== "moof"), bytes: newBytes, moov, mvhd: child(newBytes, moov, "mvhd"), tracks: [child(newBytes, moov, "trak")], fragmented: false};
}





