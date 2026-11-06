import {fetchMedia, httpFailure} from "./media-request.js";

export const MAX_BYTES = 4 * 1024 ** 3;
export const MAX_SEGMENT_BYTES = 512 * 1024 ** 2;
const MAX_PLAYLIST_BYTES = 16 * 1024 ** 2;
const MAX_SEGMENTS = 50_000;

export function httpUrl(value, base) {
  let url;
  try {
    url = new URL(value, base);
  } catch {
    throw new Error("清单内含无效的资源地址。");
  }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("仅可读取 HTTP 或 HTTPS 媒体地址。");
  }
  return url.href;
}

function attributes(line) {
  const result = {};
  const list = line.slice(line.indexOf(":") + 1);
  const matcher = /([A-Z0-9-]+)=("[^"]*"|[^,]+)(?:,|$)/gy;
  let pos = 0;
  while (pos < list.length) {
    const match = matcher.exec(list);
    if (!match) throw new Error("清单的属性格式有误。");
    if (Object.hasOwn(result, match[1])) throw new Error("清单含重复属性，无法确定其内容。");
    result[match[1]] = match[2].replace(/^"|"$/g, "");
    pos = matcher.lastIndex;
  }
  return result;
}

function parseRange(spec, url, previous) {
  if (spec == null) return null;
  const match = /^(\d+)(?:@(\d+))?$/.exec(spec);
  if (!match) throw new Error("清单的字节范围格式有误。");
  const length = Number(match[1]);
  const offset = match[2] !== undefined ? Number(match[2]) :
    previous?.url === url && previous.range ? previous.range.end + 1 : NaN;
  const end = offset + length - 1;
  if (length <= 0 || !Number.isSafeInteger(offset) || !Number.isSafeInteger(end)) {
    throw new Error("无法确定分片的字节范围。");
  }
  return {start: offset, end, length};
}

function parseMaster(lines, base) {
  const variants = [];
  const tracks = [];
  let pending = null;
  for (const line of lines) {
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      if (pending) throw new Error("清单缺少画质地址。");
      pending = attributes(line);
    } else if (line.startsWith("#EXT-X-MEDIA:")) {
      tracks.push(attributes(line));
    } else if (!line.startsWith("#")) {
      if (!pending) throw new Error("清单内有无法识别的地址。");
      variants.push({...pending, url: httpUrl(line, base)});
      pending = null;
    }
  }
  if (pending || !variants.length) throw new Error("清单中没有可选的媒体轨道。");
  if (variants.length + tracks.length > 400) throw new Error("清单的轨道过多。");
  const options = variants.sort((a, b) => (Number(b.BANDWIDTH) || 0) - (Number(a.BANDWIDTH) || 0))
    .map((variant, i) => {
      const audioTracks = tracks.filter(t => t.TYPE === "AUDIO" && t["GROUP-ID"] === variant.AUDIO);
      const separate = audioTracks.length > 0 && audioTracks.every(t => t.URI);
      const resolution = variant.RESOLUTION?.replace("x", " × ");
      const bandwidth = Number(variant.BANDWIDTH) / 1000;
      const label = [resolution || variant.NAME || ("主轨道 " + (i + 1)),
        bandwidth > 0 ? Math.round(bandwidth) + " kbps" : "",
        separate ? "音轨单独保存" : ""].filter(Boolean).join(" · ");
      return {label, url: variant.url, audio: false};
    });
  const seen = new Set();
  for (const track of tracks) {
    if (!["AUDIO", "VIDEO"].includes(track.TYPE) || !track.URI) continue;
    const url = httpUrl(track.URI, base);
    if (seen.has(url)) continue;
    seen.add(url);
    const audio = track.TYPE === "AUDIO";
    const label = [audio ? "独立音轨" : "独立视频轨", track.NAME, track.LANGUAGE].filter(Boolean).join(" · ");
    options.push({label, url, audio});
  }
  return {options};
}

export function parsePlaylist(source, base) {
  // Bound the number of allocations independently of the playlist's byte length.
  let lineCount = 1;
  for (let pos = source.indexOf("\n"); pos >= 0; pos = source.indexOf("\n", pos + 1)) {
    if (++lineCount > 400_000) throw new Error("清单的行数过多。");
  }
  const lines = source.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines[0] !== "#EXTM3U") {
    const error = new Error("服务器没有返回 HLS 清单，链接可能已过期。");
    error.canTryAnotherPlaylist = true;
    throw error;
  }
  for (const line of lines) {
    if (line.startsWith("#EXT-X-SESSION-KEY:") || line === "#EXT-X-KEY") {
      throw new Error("此清单包含加密轨道，无法导出。");
    }
    if (line.startsWith("#EXT-X-KEY:")) {
      const key = attributes(line);
      if (key.METHOD !== "NONE" || Object.keys(key).length !== 1) throw new Error("此清单包含加密轨道，无法导出。");
    }
    if (line.startsWith("#EXT-X-SKIP:") && attributes(line)["SKIPPED-SEGMENTS"] !== "0") {
      throw new Error("该增量清单省略了部分分片，请从原网页打开完整的点播清单。");
    }
    if (line.startsWith("#EXT-X-DEFINE:") || line.includes("{$")) {
      throw new Error("暂不支持使用变量的 HLS 清单。");
    }
  }
  if (lines.some(line => line.startsWith("#EXT-X-STREAM-INF:"))) return parseMaster(lines, base);
  if (!lines.includes("#EXT-X-ENDLIST")) throw new Error("此直播或播放列表尚未结束。请在点播版本可用后重试。");
  if (lines.some(line => ["#EXT-X-I-FRAMES-ONLY", "#EXT-X-GAP", "#EXT-X-DISCONTINUITY"].includes(line))) {
    throw new Error("清单含跳段、缺失片段或仅含关键帧，暂时无法合并。");
  }
  const segments = [];
  let init = null;
  let duration = 0;
  let nextDuration = null;
  let rangeSpec = null;
  for (const line of lines) {
    if (line.startsWith("#EXT-X-MAP:")) {
      const attr = attributes(line);
      if (!attr.URI) throw new Error("清单缺少初始化片段地址。");
      const url = httpUrl(attr.URI, base);
      const range = parseRange(attr.BYTERANGE, url, segments.at(-1));
      if (segments.length && (!init || init.url !== url ||
          init.range?.start !== range?.start || init.range?.end !== range?.end)) {
        throw new Error("媒体使用了多个初始化片段，暂时无法合并。");
      }
      init = {url, range};
    } else if (line.startsWith("#EXTINF:")) {
      if (nextDuration !== null) throw new Error("清单缺少分片地址。");
      const value = line.slice(8).split(",")[0];
      nextDuration = Number(value);
      if (!value || !Number.isFinite(nextDuration) || nextDuration < 0) throw new Error("清单的分片时长有误。");
    } else if (line.startsWith("#EXT-X-BYTERANGE:")) {
      rangeSpec = line.slice(17);
    } else if (!line.startsWith("#")) {
      if (nextDuration === null) throw new Error("清单缺少分片时长。");
      const url = httpUrl(line, base);
      segments.push({url, range: parseRange(rangeSpec, url, segments.at(-1))});
      if (segments.length > MAX_SEGMENTS) throw new Error("单次最多合并 50,000 个分片。");
      duration += nextDuration;
      nextDuration = null;
      rangeSpec = null;
    }
  }
  if (!segments.length || rangeSpec !== null || nextDuration !== null) throw new Error("清单缺少完整的媒体分片。");
  return {segments, init, duration};
}

export async function readResource(part, signal, maxBytes = MAX_SEGMENT_BYTES, credentialOrigin) {
  const sizeError = maxBytes === MAX_SEGMENT_BYTES ? "单个分片超过 512 MiB 上限。" : "播放列表超出大小上限。";
  if (part.range && part.range.length > maxBytes) throw new Error(sizeError);
  const headers = part.range ? {Range: "bytes=" + part.range.start + "-" + part.range.end} : {};
  const response = await fetchMedia(part.url, signal, credentialOrigin, headers);
  const fail = (message, retryable = false) => {
    response.body?.cancel().catch(() => {});
    const error = new Error(message);
    error.retryable = retryable;
    error.canTryAnotherPlaylist = !response.ok;
    throw error;
  };
  if (!response.ok || !response.body) {
    fail(httpFailure(response.status), [408, 500, 502, 503, 504].includes(response.status));
  }
  let expectedSize;
  const encoding = response.headers.get("Content-Encoding")?.toLowerCase();
  const encoded = Boolean(encoding && encoding !== "identity");
  const rangeHeader = response.headers.get("Content-Range");
  if (part.range || response.status === 206 || rangeHeader !== null) {
    const range = /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(rangeHeader || "");
    if (response.status !== 206 || !range || encoded) fail("服务器未返回有效的媒体字节范围。");
    const start = Number(range[1]);
    const end = Number(range[2]);
    const total = range[3] === "*" ? null : Number(range[3]);
    if (![start, end].every(Number.isSafeInteger) || end < start ||
        (total !== null && (!Number.isSafeInteger(total) || end >= total))) fail("服务器返回的字节范围无效。");
    if (part.range && (start !== part.range.start || end !== part.range.end)) {
      fail("服务器未返回清单要求的字节范围。");
    }
    if (!part.range && (start !== 0 || end + 1 !== total)) fail("服务器仅返回了部分分片，无法完整保存。");
    expectedSize = end - start + 1;
  } else if (!encoded && response.headers.has("Content-Length")) {
    expectedSize = Number(response.headers.get("Content-Length"));
  }
  if (expectedSize > maxBytes) fail(sizeError);
  let size = 0;
  const checked = response.body.pipeThrough(new TransformStream({
    transform(chunk, stream) {
      size += chunk.byteLength;
      if (size > maxBytes) throw new Error(sizeError);
      if (size > expectedSize) throw new Error("分片超出了服务器声明的长度。");
      stream.enqueue(chunk);
    },
    flush() {
      if (!size || (expectedSize !== undefined && size !== expectedSize)) throw new Error("分片内容不完整，请重试。");
    }
  }));
  // The browser manages backing storage for this one bounded Blob.
  return {blob: await new Response(checked).blob(), url: response.url};
}

export async function loadPlaylist(url, signal, credentialOrigin) {
  const {blob, url: finalUrl} = await readResource({url: httpUrl(url)}, signal, MAX_PLAYLIST_BYTES, credentialOrigin);
  return parsePlaylist(await blob.text(), finalUrl);
}

function fourcc(bytes, offset) {
  return String.fromCharCode(...bytes.subarray(offset, offset + 4));
}

async function* mp4Boxes(blob, offset, end, budget) {
  while (offset < end) {
    budget.signal?.throwIfAborted();
    if (++budget.count > 4096) throw new Error("MP4 片段的结构过于复杂。");
    const bytes = new Uint8Array(await blob.slice(offset, Math.min(offset + 16, end)).arrayBuffer());
    if (bytes.length < 8) throw new Error("MP4 片段的结构不完整。");
    const view = new DataView(bytes.buffer);
    let size = view.getUint32(0);
    const extended = size === 1;
    if (extended) {
      if (bytes.length < 16) throw new Error("MP4 片段的结构不完整。");
      size = Number(view.getBigUint64(8));
    } else if (!size) {
      size = end - offset;
    }
    const payload = offset + (extended ? 16 : 8);
    if (offset + size < payload || offset + size > end) throw new Error("MP4 片段的结构不完整。");
    yield {type: fourcc(bytes, 4), payload, end: offset + size};
    offset += size;
  }
}

// Inspect actual sample entry types in track metadata, never arbitrary payload bytes.
const SAMPLE_TABLE_PATH = ["trak", "mdia", "minf", "stbl", "stsd"];
async function checkMovieTracks(blob, box, level, budget) {
  const sampleEntries = level === SAMPLE_TABLE_PATH.length;
  const start = box.payload + (sampleEntries ? 8 : 0); // stsd full-box header + entry count
  if (start > box.end) throw new Error("MP4 轨道信息不完整。");
  for await (const child of mp4Boxes(blob, start, box.end, budget)) {
    if (sampleEntries && ["encv", "enca", "enct", "encs", "drms", "drmi"].includes(child.type)) {
      throw new Error("MP4 轨道已加密，无法导出。");
    }
    if (child.type === SAMPLE_TABLE_PATH[level]) await checkMovieTracks(blob, child, level + 1, budget);
  }
}

async function checkMp4(blob, init, signal) {
  // Follow box sizes without loading the mdat payload, even for very large fragments.
  const budget = {count: 0, signal};
  let fileType = false;
  let pendingFragment = false;
  let complete = false;
  for await (const box of mp4Boxes(blob, 0, blob.size, budget)) {
    if (init) {
      if (box.type === "ftyp") fileType = true;
      if (box.type === "moov" && fileType && box.end > box.payload) {
        await checkMovieTracks(blob, box, 0, budget);
        complete = true;
      }
    } else if (box.type === "moof") {
      if (pendingFragment || box.end === box.payload) throw new Error("MP4 片段缺少完整的媒体数据。");
      pendingFragment = true;
    } else if (box.type === "mdat" && pendingFragment && box.end > box.payload) {
      complete = true;
      pendingFragment = false;
    }
  }
  if (!complete || pendingFragment) throw new Error("服务器返回的 MP4 片段缺少必要的媒体数据。");
}

export async function checkSegment(blob, stage, audio, signal) {
  signal?.throwIfAborted();
  let bytes = new Uint8Array(await blob.slice(0, 377).arrayBuffer());
  const transportStream = blob.size % 188 === 0 && bytes[0] === 0x47 &&
    (bytes.length <= 188 || bytes[188] === 0x47) && (bytes.length <= 376 || bytes[376] === 0x47);
  if (stage !== "fragment" && transportStream) return {ext: "ts", mime: "video/mp2t", blob};
  if (stage === "init" || stage === "fragment") {
    await checkMp4(blob, stage === "init", signal);
    return audio ? {ext: "m4a", mime: "audio/mp4", blob} : {ext: "mp4", mime: "video/mp4", blob};
  }
  // Packed audio HLS can prefix each segment with an ID3 timestamp.
  if (fourcc(bytes, 0).startsWith("ID3") && bytes.length >= 10) {
    const id3Size = bytes.slice(6, 10).reduce((total, byte) => total * 128 + (byte & 0x7f), 0);
    blob = blob.slice(10 + id3Size + ((bytes[5] & 0x10) && bytes[3] === 4 ? 10 : 0));
    bytes = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) {
    return {ext: "aac", mime: "audio/aac", blob};
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && (bytes[1] & 0xe6) === 0xe2 && (bytes[1] & 0x18) !== 0x08) {
    return {ext: "mp3", mime: "audio/mpeg", blob};
  }
  throw new Error("分片格式无法识别。可合并 MPEG-TS、带初始化片段的 fMP4、AAC 和 MP3。");
}

export async function appendSegment(writable, blob, bytesWritten, signal) {
  signal.throwIfAborted();
  const nextSize = bytesWritten + blob.size;
  if (nextSize > MAX_BYTES) throw new Error("合并后的文件超过 4 GiB 上限。");
  await writable.write(blob);
  signal.throwIfAborted();
  return nextSize;
}

export function fileStem(title) {
  const cleaned = (title || "媒体").replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "_")
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, "").replace(/\.(m3u8?|mp4|m4a|ts|aac|mp3)$/i, "")
    .trim().slice(0, 100).replace(/^[. ]+|[. ]+$/g, "") || "媒体";
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned) ? "_" + cleaned : cleaned;
}
