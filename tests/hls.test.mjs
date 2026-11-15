import assert from "node:assert/strict";
import test from "node:test";
import {appendSegment, checkSegment, parsePlaylist, readResource} from "../extension/hls-core.js";

const base = "https://media.example/vod/master.m3u8";
const vod = (...body) => ["#EXTM3U", ...body, "#EXT-X-ENDLIST"].join("\n");
const ok = () => new AbortController().signal;

function box(type, ...payload) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.reduce((size, part) => size + part.length, 0));
  header.write(type, 4, "ascii");
  return Buffer.concat([header, ...payload]);
}

test("playlist honors implicit ranges only on the same URI and rejects incomplete/encrypted exports", () => {
  const source = vod("#EXTINF:2,", "#EXT-X-BYTERANGE:188@0", "a.ts",
    "#EXTINF:1,", "#EXT-X-BYTERANGE:376", "a.ts");
  const playlist = parsePlaylist(source, base);
  assert.deepEqual(playlist.segments[1].range, {start: 188, end: 563, length: 376});
  assert.throws(() => parsePlaylist(source.replace("376\na.ts", "376\nb.ts"), base));
  for (const directive of ["#EXT-X-KEY:METHOD=AES-128,URI=\"key\"", "#EXT-X-KEY:METHOD=AES-128,METHOD=NONE",
    "#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES", "#EXT-X-SKIP:SKIPPED-SEGMENTS=21", "#EXT-X-GAP"]) {
    assert.throws(() => parsePlaylist(vod(directive, "#EXTINF:1,", "a.ts"), base), directive);
  }
  assert.throws(() => parsePlaylist(source.replace("#EXT-X-ENDLIST", ""), base));
});

test("validates complete/ranged HTTP payloads, including decoded Content-Encoding", async t => {
  let response;
  const http = t.mock.method(globalThis, "fetch", async () => response);
  const whole = {url: base};
  const partial = {url: base, range: {start: 5, end: 8, length: 4}};
  const ranged = (range, size = 4) => new Response(Buffer.alloc(size), {status: 206, headers: {"Content-Range": range}});
  response = ranged("bytes 5-8/20");
  await assert.rejects(readResource(whole, ok()), /部分/);
  response = ranged("bytes 0-3/4");
  assert.equal((await readResource(whole, ok())).blob.size, 4);
  response = ranged("bytes 5-8/20");
  assert.equal((await readResource(partial, ok())).blob.size, 4);
  assert.equal(http.mock.calls.at(-1).arguments[1].headers.Range, "bytes=5-8");
  for (const invalid of [ranged("bytes 5-8/8"), ranged("bytes 5-8/*", 2), new Response(Buffer.alloc(20))]) {
    response = invalid;
    await assert.rejects(readResource(partial, ok()));
  }
  response = new Response("short", {headers: {"Content-Length": "32"}});
  await assert.rejects(readResource(whole, ok()), /不完整/);
  response = new Response("decoded text", {headers: {"Content-Encoding": "gzip", "Content-Length": "48"}});
  assert.equal(await (await readResource(whole, ok())).blob.text(), "decoded text");
});

test("limits browser credentials to the observed media origin and follows redirects anonymously", async t => {
  const origin = new URL(base).origin;
  const foreign = "https://cdn.example/seg.ts";
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push([url, init.credentials, init.redirect]);
    if (init.redirect === "manual") return Object.defineProperty(new Response(), "type", {value: "opaqueredirect"});
    return new Response("part");
  });
  await readResource({url: base}, ok(), 32, origin);
  await readResource({url: foreign}, ok(), 32, origin);
  await readResource({url: base}, ok());
  assert.deepEqual(calls, [
    [base, "include", "manual"], [base, "omit", "follow"], [foreign, "omit", "follow"], [base, "omit", "follow"]
  ]);
});

test("explains login, denied and precondition HTTP errors without exposing signed URLs", async t => {
  let status;
  t.mock.method(globalThis, "fetch", async () => new Response(null, {status}));
  for (const [code, text] of [[401, /401.*登录/], [403, /403.*拒绝/], [412, /412.*来源/]]) {
    status = code;
    await assert.rejects(readResource({url: base + "?secret=private"}, ok()),
      error => text.test(error.message) && !error.message.includes("secret"));
  }
});

test("checks MP4 box boundaries, media data and protected sample entries without scanning media bytes", async () => {
  const header = box("ftyp", Buffer.from("iso6\0\0\0\0"));
  const entryCount = Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]);
  function init(sampleType) {
    const sampleTable = box("stsd", entryCount, box(sampleType, Buffer.from("metadata containing encv is not a box")));
    const track = box("trak", box("mdia", box("minf", box("stbl", sampleTable))));
    return new Blob([header, box("moov", track)]);
  }
  assert.equal((await checkSegment(init("avc1"), "init", false)).ext, "mp4");
  await assert.rejects(checkSegment(init("encv"), "init", false), /加密/);
  const fragment = box("moof", box("traf"));
  const data = box("mdat", Buffer.from("sample"));
  assert.equal((await checkSegment(new Blob([fragment, data]), "fragment", false)).ext, "mp4");
  for (const bad of [new Blob([fragment]), new Blob([fragment, data, fragment]), new Blob([fragment, data.subarray(0, -1)])]) {
    await assert.rejects(checkSegment(bad, "fragment", false));
  }
  const canceled = AbortSignal.abort();
  await assert.rejects(checkSegment(init("mp4a"), "init", true, canceled), {name: "AbortError"});
});

test("supports TS map headers and counts post-ID3 payload against the exact 4 GiB boundary", async () => {
  const ts = Buffer.alloc(188 * 2);
  ts[0] = ts[188] = 0x47;
  assert.equal((await checkSegment(new Blob([ts]), "init", false)).ext, "ts");
  const id3 = Buffer.from([73, 68, 51, 4, 0, 0, 0, 0, 0, 2, 0, 0]);
  const adts = Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x01, 0x1f, 0xfc, 0]);
  const audio = await checkSegment(new Blob([id3, adts]), "media", true);
  assert.equal(audio.ext, "aac");
  assert.equal(audio.blob.size, adts.length);
  const limit = 4_294_967_296;
  const writes = [];
  const sink = {write: blob => writes.push(blob.size)};
  assert.equal(await appendSegment(sink, audio.blob, limit - adts.length, ok()), limit);
  await assert.rejects(appendSegment(sink, audio.blob, limit - adts.length + 1, ok()), /4 GiB/);
  await assert.rejects(appendSegment(sink, audio.blob, 0, AbortSignal.abort()), {name: "AbortError"});
  assert.deepEqual(writes, [adts.length]);
  const abort = new AbortController();
  await assert.rejects(appendSegment({write: () => abort.abort()}, audio.blob, 0, abort.signal), {name: "AbortError"});
});

test("download page rolls back a partial response or cancellation and starts from zero on retry", {timeout: 5000}, async t => {
  let ready;
  const prepared = new Promise(resolve => { ready = resolve; });
  const ids = "start cancel retry track tracks track-hint bar summary status title site alternatives alternative-list".split(" ");
  const ui = Object.fromEntries(ids.map(id => [id, {id, classList: {toggle() {}},
    addEventListener(event, fn) { this[event] = fn; }}]));
  ui.track.replaceChildren = () => { ui.track.selectedIndex = 0; };
  const links = [];
  ui["alternative-list"].append = row => {
    links.push(row.child);
    ui["alternative-list"].childElementCount = links.length;
  };
  Object.defineProperty(ui.start, "disabled", {set(value) { if (!value) ready(); }});

  let mode = "master-failed";
  let committed = Buffer.from("previous file");
  let aborts = 0;
  const pickedNames = [];
  const handle = {name: "video.ts", createWritable: async () => {
    const writes = [];
    return {
      async write(blob) {
        writes.push(Buffer.from(await blob.arrayBuffer()));
        if (mode === "cancel") ui.cancel.click();
      },
      close() { committed = Buffer.concat(writes); },
      async abort() { aborts++; }
    };
  }};
  const globals = {
    document: {querySelectorAll: () => Object.values(ui), createElement: () => ({append(node) { this.child = node; }})},
    location: new URL("chrome-extension://test/hls.html#tab=1&item=abc"),
    chrome: {runtime: {sendMessage: async () => ({ok: true, credentialOrigin: new URL(base).origin,
      item: {name: "video", url: base, kind: "hls"}, alternatives: [{id: "variant-id", name: "index-v1-a1.m3u8"}]})}},
    Option: class {constructor(label, value) { this.label = label; this.value = value; }},
    window: {showSaveFilePicker: async args => { pickedNames.push(args.suggestedName); return handle; }}
  };
  for (const [name, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {value, configurable: true});
    t.after(() => previous ? Object.defineProperty(globalThis, name, previous) : delete globalThis[name]);
  }
  const ts = Buffer.alloc(188);
  ts[0] = 0x47;
  const second = "https://cdn.example/two.ts";
  const variant = new URL("track.m3u8", base).href;
  t.mock.method(globalThis, "fetch", async (url, request) => {
    if (new URL(url).origin === new URL(base).origin && request.credentials !== "include") return new Response(null, {status: 401});
    if (url === second && request.credentials !== "omit") throw new Error("unexpected cross-origin credentials");
    if (url === base) {
      if (mode === "master-failed") return new Response(null, {status: 403});
      const response = new Response("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=640x360\ntrack.m3u8");
      return Object.defineProperty(response, "url", {value: url});
    }
    if (url === variant) {
      const response = new Response(vod("#EXTINF:1,", "one.ts", "#EXTINF:1,", second));
      return Object.defineProperty(response, "url", {value: url});
    }
    if (url === second && mode === "partial") return new Response(ts, {status: 206, headers: {"Content-Range": "bytes 0-187/376"}});
    return new Response(ts);
  });
  await import("../extension/hls.js");
  await new Promise(resolve => setImmediate(resolve));
  assert.match(ui.status.textContent, /播放清单读取失败。HTTP 403/);
  assert.equal(ui.alternatives.hidden, false);
  assert.equal(links[0].href, "chrome-extension://test/hls.html#tab=1&item=variant-id");
  assert.equal(links[0].textContent, "index-v1-a1.m3u8");
  mode = "partial";
  await ui.retry.click();
  await prepared;
  assert.equal(ui.alternatives.hidden, true);
  await ui.start.click();
  assert.match(ui.status.textContent, /部分/);
  assert.equal(committed.toString(), "previous file");
  mode = "cancel";
  await ui.start.click();
  assert.match(ui.status.textContent, /取消/);
  assert.equal(committed.toString(), "previous file");
  assert.equal(aborts, 2);
  mode = "success";
  await ui.start.click();
  assert.match(ui.status.textContent, /已保存/);
  assert.deepEqual(committed, Buffer.concat([ts, ts]));
  assert.deepEqual(pickedNames, Array(3).fill("video - 640 × 360 · 1000 kbps.ts"));
});
import {createHlsMp4Finalizer} from "../extension/hls-mp4.js";
import {spawnSync} from "node:child_process";
import {mkdir, mkdtemp, readFile, writeFile} from "node:fs/promises";
import {resolve, join} from "node:path";
import {fileURLToPath} from "node:url";

function full(type, payload, version = 0) {
  return box(type, Buffer.from([version, 0, 0, 0]), payload);
}
function words(...values) {
  const data = Buffer.alloc(values.length * 4); values.forEach((value,index) => data.writeUInt32BE(value,index * 4)); return data;
}
function timingFixture(version = 0, ids = [1,2], editCount = 0) {
  const movie = Buffer.alloc(version ? 108 : 96), scaleAt = version ? 16 : 8;
  movie.writeUInt32BE(1000,scaleAt);
  const tracks = ids.map(id => {
    const header = Buffer.alloc(version ? 92 : 80); header.writeUInt32BE(id,version ? 16 : 8);
    const media = Buffer.alloc(version ? 40 : 28); media.writeUInt32BE(48000,scaleAt);
    const edits = editCount ? box("edts",full("elst",Buffer.concat([words(editCount),Buffer.alloc(editCount * 12)]))) : Buffer.alloc(0);
    return box("trak",full("tkhd",header,version),box("mdia",full("mdhd",media,version)),edits);
  });
  const init = new Blob([box("ftyp",Buffer.from("iso6\0\0\0\0")),box("moov",full("mvhd",movie,version),...tracks,
    box("mvex",...ids.map(id => full("trex",words(id,1,1024,4,0)))))]);
  const fragment = new Blob([box("moof",...ids.map(id => {
    const tfdt = version ? Buffer.alloc(8) : words(0);
    return box("traf",full("tfhd",words(id)),full("tfdt",tfdt,version),full("trun",words(id === 1 ? 94 : 96)));
  })),box("mdat",Buffer.alloc(768))]);
  return {init,fragment};
}

test("HLS MP4 duration finalizer supports audio-only/multi-traf and v0/v1 fields, bounds and cancel", async () => {
  for (const version of [0,1]) for (const ids of [[1],[1,2]]) {
    const {init,fragment} = timingFixture(version,ids), output = Buffer.concat([Buffer.from(await init.arrayBuffer()),Buffer.from(await fragment.arrayBuffer())]);
    const original = Buffer.from(output), patches = [];
    const finalizer = await createHlsMp4Finalizer(init,ok());
    await finalizer.observe(fragment,ok());
    const result = await finalizer.finalize({write(operation) { patches.push(operation); Buffer.from(operation.data).copy(output,operation.position); }},ok());
    assert.equal(result.duration,ids.length === 1 ? 2.006 : 2.048);
    assert.equal(patches.length,1 + ids.length * 2);
    const movieAt = output.indexOf(Buffer.from("mvhd")) + (version ? 28 : 20);
    assert.equal(version ? Number(output.readBigUInt64BE(movieAt)) : output.readUInt32BE(movieAt), Math.round(result.duration * 1000));
    let trackAt = 0, mediaAt = 0;
    for (const id of ids) {
      trackAt = output.indexOf(Buffer.from("tkhd"),trackAt + 1);
      mediaAt = output.indexOf(Buffer.from("mdhd"),mediaAt + 1);
      const durationAt = trackAt + (version ? 32 : 24), decodedAt = mediaAt + (version ? 28 : 20), expectedSamples = id === 1 ? 94 : 96;
      assert.equal(version ? Number(output.readBigUInt64BE(durationAt)) : output.readUInt32BE(durationAt), Math.ceil(expectedSamples * 1024 / 48));
      assert.equal(version ? Number(output.readBigUInt64BE(decodedAt)) : output.readUInt32BE(decodedAt), expectedSamples * 1024);
    }
    assert.ok(patches.every(patch => patch.data.length === (version ? 8 : 4)));
    assert.deepEqual(output.subarray(init.size),original.subarray(init.size));
    assert.notDeepEqual(output.subarray(0,init.size),original.subarray(0,init.size));
    const abort = new AbortController(); abort.abort();
    await assert.rejects(finalizer.finalize({write() { throw new Error("must not write"); }},abort.signal),{name:"AbortError"});
  }
  const {init,fragment} = timingFixture(0,[1]), finalizer = await createHlsMp4Finalizer(init,ok());
  const malformed = Buffer.from(await fragment.arrayBuffer()), run = malformed.indexOf(Buffer.from("trun"));
  malformed.writeUInt32BE(10000001,run + 8);
  await assert.rejects(finalizer.observe(new Blob([malformed]),ok()),/样本时长/);
  await assert.rejects(createHlsMp4Finalizer(new Blob([box("ftyp")]),ok()),/moov/);
  await assert.rejects(createHlsMp4Finalizer(timingFixture(0,[1],4097).init,ok()),/条目过多/);
  await assert.rejects(createHlsMp4Finalizer(init,AbortSignal.abort()),{name:"AbortError"});
});

const ffmpegAvailable = spawnSync("ffmpeg",["-version"]).status === 0 && spawnSync("ffprobe",["-version"]).status === 0;
function runMedia(command,args,options = {}) {
  const result = spawnSync(command,args,{encoding:"utf8",windowsHide:true,maxBuffer:4 * 1024 ** 2,...options});
  assert.equal(result.status,0,result.stderr || result.error?.message); return result.stdout;
}
test("8-second multi-track HLS fMP4 preserves all packet timestamps/hashes and exposes native duration/seek", {skip:!ffmpegAvailable,timeout:30000}, async () => {
  await mkdir(resolve("work"),{recursive:true}); const dir = await mkdtemp(join(resolve("work"),"hls-finalize-"));
  const playlistPath = join(dir,"track.m3u8");
  runMedia("ffmpeg",["-nostdin","-v","error","-f","lavfi","-i","testsrc2=size=96x64:rate=12:duration=8","-f","lavfi","-i","sine=frequency=440:sample_rate=48000:duration=8",
    "-c:v","libx264","-pix_fmt","yuv420p","-preset","ultrafast","-g","12","-sc_threshold","0","-c:a","aac","-b:a","32k","-f","hls","-hls_time","1","-hls_playlist_type","vod","-hls_segment_type","fmp4",
    "-hls_fmp4_init_filename","init.mp4","-hls_segment_filename","seg-%d.m4s","-y","track.m3u8"],{cwd:dir});
  const playlist = parsePlaylist(await readFile(playlistPath,"utf8"),"https://example.test/track.m3u8");
  const init = new Blob([await readFile(join(dir,"init.mp4"))]), parts = [Buffer.from(await init.arrayBuffer())];
  const finalizer = await createHlsMp4Finalizer(init,ok());
  for (const segment of playlist.segments) {
    const data = await readFile(join(dir,new URL(segment.url).pathname.slice(1)));
    const checked = await checkSegment(new Blob([data]),"fragment",false,ok());
    await finalizer.observe(checked.blob,ok()); parts.push(data);
  }
  const raw = Buffer.concat(parts), finalized = Buffer.from(raw), rawPath = join(dir,"raw.mp4"), finalizedPath = join(dir,"finalized.mp4");
  const result = await finalizer.finalize({write(operation) { Buffer.from(operation.data).copy(finalized,operation.position); }},ok());
  assert.ok(result.duration >= 8 && result.duration < 8.1);
  assert.deepEqual(finalized.subarray(init.size),raw.subarray(init.size));
  await writeFile(rawPath,raw); await writeFile(finalizedPath,finalized);
  const packets = file => JSON.parse(runMedia("ffprobe",["-v","error","-show_packets","-show_data_hash","sha256","-of","json",file])).packets.map(packet => [packet.stream_index,packet.pts_time,packet.dts_time,packet.duration_time,packet.data_hash]);
  assert.deepEqual(packets(finalizedPath),packets(rawPath));
  runMedia("ffmpeg",["-nostdin","-v","error","-xerror","-i",finalizedPath,"-f","null","-"]);
  if (process.platform === "win32") {
    const report = JSON.parse(runMedia("powershell",["-NoProfile","-ExecutionPolicy","Bypass","-File",fileURLToPath(new URL("./native-playback.ps1",import.meta.url)),finalizedPath]));
    assert.equal(report[0].Ok,true);assert.ok(report[0].Video.Duration >= 8);assert.equal(report[0].Video.SeekChecked,true);assert.equal(report[0].Audio.SeekChecked,true);
  }
});


