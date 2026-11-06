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
  const ids = "start cancel retry track tracks track-hint bar summary status title site".split(" ");
  const ui = Object.fromEntries(ids.map(id => [id, {id, classList: {toggle() {}},
    addEventListener(event, fn) { this[event] = fn; }}]));
  ui.track.replaceChildren = () => { ui.track.selectedIndex = 0; };
  Object.defineProperty(ui.start, "disabled", {set(value) { if (!value) ready(); }});

  let mode = "partial";
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
    document: {querySelectorAll: () => Object.values(ui)},
    location: {hash: "#tab=1&item=abc"},
    chrome: {runtime: {sendMessage: async () => ({ok: true, credentialOrigin: new URL(base).origin,
      item: {name: "video", url: base, kind: "hls"}})}},
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
  await prepared;
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
