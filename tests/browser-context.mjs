// node tests/browser-context.mjs <desktop Chrome or Edge executable>; requires ffmpeg and ffprobe on PATH.
// Uses only ephemeral profiles, loopback servers, and the browser's private CDP pipe.
import assert from "node:assert/strict";
import {execFileSync, spawn} from "node:child_process";
import {createHash} from "node:crypto";
import {once} from "node:events";
import {mkdir, mkdtemp, readFile, realpath, rm, writeFile} from "node:fs/promises";
import {createServer} from "node:http";
import {tmpdir} from "node:os";
import path from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import {fileURLToPath} from "node:url";

const executable = process.argv[2];
if (!executable) throw new Error("Pass the path to a Chrome or Edge executable.");
const extension = fileURLToPath(new URL("../extension", import.meta.url));
const temp = await realpath(tmpdir());
const profile = await mkdtemp(path.join(temp, "shiliu-context-"));
const requests = [];
const servers = [];
let phase = "control";

// Five silent 48 kHz mono AAC frames generated with FFmpeg's native AAC encoder.
const aac = Buffer.from("//FMQAOf/N4CAExhdmM2My4xNS4xMDAAAABADv/xTEABf/wAACAH//FMQAF//AAAIAf/8UxAAX/8AAAgB//xTEABf/wAACAH", "base64");
const wav = Buffer.alloc(44 + 2048);
wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(wav.length - 44, 40);

async function makeMovie(dir) {
  await mkdir(dir);
  const variant = "index-v1-a1.m3u8";
  const init = "init-v1-a1.mp4";
  execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=96x64:rate=12:duration=2",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast", "-g", "12", "-sc_threshold", "0",
    "-c:a", "aac", "-b:a", "32k", "-f", "hls", "-hls_time", "1", "-hls_playlist_type", "vod",
    "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", init, "-hls_segment_filename", "seg-%d-v1-a1.m4s",
    variant], {cwd: dir, windowsHide: true});
  const playlist = await readFile(path.join(dir, variant), "utf8");
  const segments = playlist.split(/\r?\n/).filter(line => line.endsWith(".m4s"));
  assert.ok(segments.length >= 2 && playlist.includes('URI="' + init + '"'));
  const names = [init, ...segments];
  const parts = await Promise.all(names.map(name => readFile(path.join(dir, name))));
  const routes = Object.fromEntries(names.map((name, i) => ["/" + name, ["video/mp4", parts[i]]]));
  routes["/" + variant] = ["application/vnd.apple.mpegurl", playlist];
  routes["/master.m3u8"] = ["application/vnd.apple.mpegurl",
    "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=128000,RESOLUTION=96x64\n" + variant];
  return {routes, names, init, variant, expected: Buffer.concat(parts)};
}

async function verifyMovie(bytes, dir) {
  const output = path.join(dir, "saved.mp4");
  await writeFile(output, bytes);
  const report = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-count_frames", "-show_entries",
    "stream=codec_name,codec_type,width,height,duration,nb_read_frames:format=duration", "-of", "json", output],
    {encoding: "utf8", windowsHide: true}));
  const video = report.streams.find(s => s.codec_type === "video");
  const audio = report.streams.find(s => s.codec_type === "audio");
  assert.equal(video?.codec_name, "h264");
  assert.equal(video.width, 96); assert.equal(video.height, 64); assert.equal(Number(video.nb_read_frames), 24);
  assert.equal(audio?.codec_name, "aac"); assert.ok(Number(audio.nb_read_frames) >= 90);
  for (const duration of [video.duration, audio.duration, report.format.duration]) assert.ok(Math.abs(Number(duration) - 2) < 0.15);
  execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-xerror", "-i", output, "-map", "0:v", "-map", "0:a", "-f", "null", "-"],
    {windowsHide: true});
  return `H.264 ${video.nb_read_frames} frames / AAC ${audio.nb_read_frames} frames / ${report.format.duration}s`;
}

async function serve(handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.push(server);
  return "http://127.0.0.1:" + server.address().port;
}

// Send nul-delimited CDP messages on the browser child's fd 3/4, with no externally reachable port.
function connect(browser) {
  let nextId = 0;
  let input = "";
  const pending = new Map();
  browser.stdio[4].setEncoding("utf8").on("data", chunk => {
    input += chunk;
    let end;
    while ((end = input.indexOf("\0")) >= 0) {
      const message = JSON.parse(input.slice(0, end));
      input = input.slice(end + 1);
      const task = pending.get(message.id);
      if (!task) continue;
      pending.delete(message.id);
      clearTimeout(task.timer);
      if (message.error) task.reject(new Error(task.method + ": " + message.error.message));
      else task.resolve(message.result);
    }
  });
  return (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("CDP timeout: " + method)); }, 15_000);
    pending.set(id, {method, timer, resolve, reject});
    browser.stdio[3].write(JSON.stringify({id, method, params, sessionId}) + "\0");
  });
}

async function until(probe, description) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result) return result;
    await delay(100);
  }
  throw new Error("Timed out waiting for " + description);
}

let browser;
let call;
let exit;
try {
  const fixtureDir = path.join(profile, "generated-media");
  const movie = await makeMovie(fixtureDir);
  const pageOrigin = await serve((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (req.url.startsWith("/public.aac")) {
      requests.push({phase, url: req.url, ...req.headers});
      res.writeHead(200, {"Content-Type": "audio/aac"});
      return res.end(aac);
    }
    res.writeHead(200, {"Content-Type": "text/html", "Referrer-Policy": "origin",
      "Set-Cookie": "fixture_session=active; Path=/; SameSite=Lax; HttpOnly"});
    res.end("<!doctype html><title>Local media fixture</title><audio muted></audio><video muted></video>");
  });
  const cdn = await serve((req, res) => {
    const headers = req.headers;
    const validContext = headers.origin === pageOrigin && headers.referer === pageOrigin + "/";
    const session = (headers.cookie || "").includes("fixture_session=active");
    const timing = req.url.startsWith("/timing/");
    const blocked = req.url === "/nocors/blocked-master.m3u8";
    let status = validContext ? (session || timing || blocked || req.url === "/redirect.aac" ? 200 : 401) : 412;
    if (status === 200 && phase === "master-denied" && req.url === "/master.m3u8") status = 403;
    if (!blocked) {
      res.setHeader("Access-Control-Allow-Origin", pageOrigin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    res.setHeader("Cache-Control", "no-store");
    if (status === 200 && req.url === "/redirect.aac") status = 302;
    requests.push({phase, url: req.url, status, ...headers});
    if (status === 302) { res.writeHead(302, {Location: pageOrigin + "/public.aac?via=redirect"}); return res.end(); }
    if (status !== 200) { res.writeHead(status); return res.end(); }
    const route = timing ? req.url.slice("/timing".length) : blocked ? "/master.m3u8" : req.url;
    const media = {
      ...movie.routes,
      "/audio-master.m3u8": ["application/vnd.apple.mpegurl", "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=64000\ntrack.m3u8"],
      "/track.m3u8": ["application/vnd.apple.mpegurl", "#EXTM3U\n#EXTINF:0.1,\nsound.aac\n#EXTINF:0.1,\n" +
        pageOrigin + "/public.aac?via=playlist\n#EXTINF:0.1,\nredirect.aac\n#EXT-X-ENDLIST"],
      "/sound.aac": ["audio/aac", aac], "/sample.wav": ["audio/wav", wav]
    }[route];
    if (!media) { res.writeHead(404); return res.end(); }
    res.writeHead(200, {"Content-Type": media[0], "Content-Length": Buffer.byteLength(media[1])});
    res.end(media[1]);
  });
  assert.equal((await fetch(cdn + "/sample.wav")).status, 412);
  assert.equal((await fetch(cdn + "/master.m3u8", {headers: {Origin: pageOrigin, Referer: pageOrigin + "/"}})).status, 401);

  browser = spawn(executable, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-sync",
    "--disable-background-networking", "--disable-component-update", "--remote-debugging-pipe",
    "--enable-unsafe-extension-debugging", "--user-data-dir=" + profile, "about:blank"],
    {windowsHide: true, stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"]});
  exit = once(browser, "exit");
  call = connect(browser);
  const version = await call("Browser.getVersion");
  const targets = async () => (await call("Target.getTargets")).targetInfos;
  const attach = async targetId => (await call("Target.attachToTarget", {targetId, flatten: true})).sessionId;
  const create = async url => attach((await call("Target.createTarget", {url})).targetId);
  async function evaluate(session, expression) {
    const answer = await call("Runtime.evaluate", {expression, returnByValue: true, awaitPromise: true, userGesture: true}, session);
    if (answer.exceptionDetails) throw new Error(answer.exceptionDetails.exception?.description || answer.exceptionDetails.text);
    return answer.result.value;
  }

  // The two requests exist only in this tab's Resource Timing when the extension is installed.
  phase = "preinstall";
  const warm = await create(pageOrigin + "/warm");
  await until(() => evaluate(warm, "!!document.querySelector('audio')"), "preinstallation player");
  const prefetched = await evaluate(warm, `(async () => {
    const result = [];
    for (const path of ["/timing/master.m3u8", "/nocors/blocked-master.m3u8"]) {
      const url = ${JSON.stringify(cdn)} + path;
      try { result.push((await (await fetch(url, {credentials:"omit"})).text()).startsWith("#EXTM3U")); }
      catch { result.push(false); }
    }
    return result;
  })()`);
  assert.deepEqual(prefetched, [true, false]);
  assert.ok(["/timing/master.m3u8", "/nocors/blocked-master.m3u8"].every(url =>
    requests.some(r=>r.phase === "preinstall" && r.url === url && r.status === 200 && !r.cookie)));
  const {id} = await call("Extensions.loadUnpacked", {path: extension});
  const extensionOrigin = "chrome-extension://" + id;
  const worker = await until(async () => (await targets()).find(t => t.type === "service_worker" &&
    t.url === extensionOrigin + "/background.js"), "new extension to start");
  const workerSession = await attach(worker.targetId);
  await until(() => evaluate(workerSession, "globalThis.chrome?.webRequest?.onSendHeaders.hasListeners() && chrome.webRequest.onHeadersReceived.hasListeners()"),
    "new extension's capture listeners");
  await call("Target.detachFromTarget", {sessionId: workerSession});
  phase = "player";
  const player = await create(pageOrigin + "/watch");
  await until(() => evaluate(player, "!!document.querySelector('audio')"), "player");
  const played = await evaluate(player, `(async () => {
    const fetchMedia = async name => {
      const value = await fetch(${JSON.stringify(cdn)} + name, {credentials:"include"});
      if (!value.ok) throw new Error(name + " " + value.status);
      return value.blob();
    };
    const player = document.querySelector("audio");
    player.src = URL.createObjectURL(await fetchMedia("/sample.wav"));
    await player.play();
    for (const route of ["/audio-master.m3u8", "/track.m3u8", "/sound.aac", "/master.m3u8", ${JSON.stringify("/" + movie.variant)}]) {
      await fetchMedia(route);
    }
    const parts = [];
    for (const name of ${JSON.stringify(movie.names)}) parts.push(await fetchMedia("/" + name));
    const video = document.querySelector("video");
    video.src = URL.createObjectURL(new Blob(parts, {type: "video/mp4"}));
    const ended = new Promise((resolve, reject) => {
      video.onended = resolve; video.onerror = () => reject(new Error("video decode failed"));
    });
    await video.play();
    await ended;
    return player.readyState >= 2 && video.videoWidth === 96 && Math.abs(video.duration - 2) < 0.15;
  })()`);
  assert.equal(played, true);
  const popup = await create(extensionOrigin + "/popup.html");
  await until(() => evaluate(popup, "!!document.querySelector('#refresh') && !document.querySelector('#refresh').disabled"), "extension popup");
  let srcId = await evaluate(popup, `chrome.tabs.query({url:${JSON.stringify(pageOrigin + "/watch")}}).then(t=>t[0].id)`);
  await evaluate(popup, `chrome.tabs.update(${srcId}, {active:true}).then(() => document.querySelector("#refresh").click())`);
  await until(() => evaluate(popup, "[...document.querySelectorAll('.media-title')].some(el=>el.textContent==='master.m3u8')"), "captured movie master");
  assert.equal(await evaluate(popup, "[...document.querySelectorAll('.media-title')].some(el=>el.textContent==='init-v1-a1.mp4')"), false,
    "An fMP4 track initializer must not be offered as a complete file");
  const results = [];
  for (const [name, page, expected, scenario] of [["master.m3u8", "hls.html", movie.expected],
    ["audio-master.m3u8", "hls.html", Buffer.concat([aac, aac, aac])], ["sample.wav", "file.html", wav],
    ["master.m3u8", "hls.html", movie.expected, "master-denied"], ["master.m3u8", "hls.html", movie.expected, "timing"]]) {
    const deniedMaster = scenario === "master-denied";
    phase = scenario || page;
    if (scenario === "timing") {
      srcId = await evaluate(popup, `chrome.tabs.query({url:${JSON.stringify(pageOrigin + "/warm")}}).then(t=>t[0].id)`);
      await evaluate(popup, `chrome.tabs.update(${srcId}, {active:true}).then(() => document.querySelector("#refresh").click())`);
      await until(() => evaluate(popup, "[...document.querySelectorAll('.media-title')].some(el=>el.textContent==='blocked-master.m3u8')"), "preinstallation timing rows");
      const source = await evaluate(popup, `chrome.storage.session.get("media:"+${srcId}).then(s=>
        s["media:"+${srcId}].items.find(i=>i.url===${JSON.stringify(cdn + "/timing/master.m3u8")})?.source)`);
      assert.equal(source, "page", "The extension saw the original request unexpectedly");
    }
    const clicked = await evaluate(popup, `(() => {
      const row = [...document.querySelectorAll(".media-row")].find(r=>r.querySelector(".media-title").textContent===${JSON.stringify(name)});
      if (!row) return false;
      row.querySelector("button").click();return true;
    })()`);
    assert.ok(clicked, name + " missing in popup");
    let target = await until(async () => {
      const opened = (await targets()).find(t => t.url.startsWith(extensionOrigin + "/" + page + "#"));
      if (opened) return opened;
      const problem = await evaluate(popup, `(() => {
        const row = [...document.querySelectorAll(".media-row")].find(r=>r.querySelector(".media-title").textContent===${JSON.stringify(name)});
        const note = row?.querySelector(".transfer-status");
        return note?.dataset.tone === "error" ? note.textContent : "";
      })()`);
      if (problem) {
        const observed = await evaluate(popup, `(async () => {
          const state = (await chrome.storage.session.get("media:" + ${srcId}))["media:" + ${srcId}];
          return state.items.filter(i=>i.name===${JSON.stringify(name)}).map(i=>[i.source, !!i.referrer, !!i.requestOrigin]);
        })()`);
        throw new Error(name + ": " + problem + ", captured context " + JSON.stringify(observed));
      }
    }, name + " in " + page);
    let session = await attach(target.targetId);
    let deniedTarget;
    let deniedSession;
    if (deniedMaster) {
      deniedTarget = target;
      deniedSession = session;
      const error = await until(() => evaluate(session, "document.querySelector('#status.error')?.textContent"), "master 403");
      assert.match(error, /^播放清单读取失败。HTTP 403/);
      const variantId = await evaluate(popup, `[...document.querySelectorAll(".media-row")]
        .find(row => row.querySelector(".media-title").textContent === ${JSON.stringify(movie.variant)})?.dataset.item`);
      assert.ok(variantId, "variant was not captured from the player");
      assert.ok(!requests.some(r => r.phase === phase && r.url === "/" + movie.variant), "variant fetched before user choice");
      const href = await evaluate(session, `(() => {
        if (document.querySelector("#alternatives").hidden || !document.querySelector("#start").disabled) return null;
        const link = [...document.querySelectorAll("#alternative-list a")].find(a=>a.textContent===${JSON.stringify(movie.variant)});
        link?.click(); return link?.href;
      })()`);
      assert.ok(href, "captured variant link was not visible");
      assert.equal(href.split("#")[0], extensionOrigin + "/hls.html");
      assert.equal(new URLSearchParams(new URL(href).hash.slice(1)).get("item"), variantId);
      target = await until(async () => (await targets()).find(t => t.targetId !== deniedTarget.targetId && t.url === href),
        "separate variant download tab");
      session = await attach(target.targetId);
    }
    await until(async () => {
      const message = await evaluate(session, "document.querySelector('#status.error')?.textContent");
      if (message) throw new Error(page + ": " + message);
      return evaluate(session, "document.querySelector('#start')?.disabled === false");
    }, page + " preparation");
    // An unrelated extension tab cannot reuse this download's origin/referrer rule.
    const mediaUrl = cdn + (scenario === "timing" ? "/timing/" : "/") + name;
    const otherTabStatus = await evaluate(popup, `fetch(${JSON.stringify(mediaUrl)},
      {credentials:"include", referrerPolicy:"no-referrer"}).then(r=>r.status)`);
    assert.equal(otherTabStatus, 412);
    // Replace only the modal OS picker; the page receives a real native file handle/writable.
    await evaluate(session, `window.showSaveFilePicker = async ({suggestedName}) => {
      const dir = await navigator.storage.getDirectory();
      return window.fixtureHandle = await dir.getFileHandle(suggestedName, {create:true});
    };document.querySelector("#start").click()`);
    await until(async () => {
      const message = await evaluate(session, "document.querySelector('#status.error')?.textContent");
      if (message) throw new Error(page + ": " + message);
      return evaluate(session, "document.querySelector('#status')?.textContent.startsWith('已保存')");
    }, page + " commit");
    const saved = await evaluate(session, "fixtureHandle.getFile().then(f=>f.arrayBuffer()).then(b=>Array.from(new Uint8Array(b)))");
    const bytes = Buffer.from(saved);
    assert.equal(bytes.length, expected.length);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), createHash("sha256").update(expected).digest("hex"));
    if (name === "master.m3u8") {
      const label = await evaluate(session, "fixtureHandle.name");
      assert.match(label, /\.mp4$/);
      results.push(await verifyMovie(bytes, fixtureDir));
    }
    results.push((deniedMaster ? "403 → " + movie.variant : scenario === "timing" ? "timing/" + name : name) + "=" + saved.length + " verified bytes");
    if (deniedMaster) {
      assert.match(await evaluate(deniedSession, "document.querySelector('#status').textContent"), /^播放清单读取失败。HTTP 403/);
      for (const entry of [movie.variant, ...movie.names]) {
        assert.ok(requests.some(r=>r.phase === phase && r.url === "/" + entry && r.status === 200), "missing " + entry);
      }
      await call("Target.closeTarget", {targetId: deniedTarget.targetId});
    }
    await call("Target.closeTarget", {targetId: target.targetId});
    await until(() => evaluate(popup, "chrome.declarativeNetRequest.getSessionRules().then(r=>r.length===0)"), "rule cleanup");
  }
  for (const route of [...Object.keys(movie.routes), "/audio-master.m3u8", "/track.m3u8", "/sound.aac", "/sample.wav"]) {
    assert.ok(requests.some(r => r.phase.endsWith(".html") && r.url === route && r.status === 200), route + " context missing");
  }
  for (const route of Object.keys(movie.routes)) {
    const observed = requests.filter(r=>r.phase === "timing" && r.url === "/timing" + route && r.status === 200);
    assert.ok(observed.length > 0 && observed.every(r=>!r.cookie), route + " missing or credentialed during timing recovery");
  }
  // An HTTP 200 response with failed CORS must not authorize replay, even across another attempt.
  phase = "timing-denied";
  for (let attempt = 0; attempt < 2; attempt++) {
    await evaluate(popup, `[...document.querySelectorAll(".media-row")]
      .find(r=>r.querySelector(".media-title").textContent==="blocked-master.m3u8").querySelector("button").click()`);
    const denied = await until(async () => (await targets()).find(t=>t.url.startsWith(extensionOrigin + "/hls.html#")), "CORS-negative download tab");
    const session = await attach(denied.targetId);
    await until(() => evaluate(session, "!!document.querySelector('#status.error')?.textContent"), "CORS-negative refusal");
    assert.equal(await evaluate(session, "document.querySelector('#start').disabled"), true);
    const residual = await evaluate(popup, `(async () => {
      const state = (await chrome.storage.session.get("media:"+${srcId}))["media:"+${srcId}];
      const matched = state.items.filter(i=>i.url===${JSON.stringify(cdn + "/nocors/blocked-master.m3u8")});
      return {persisted: matched.some(i=>i.referrer || i.requestOrigin || i.hadCookies),
        rules: (await chrome.declarativeNetRequest.getSessionRules()).length};
    })()`);
    assert.deepEqual(residual, {persisted: false, rules: 0});
    await call("Target.closeTarget", {targetId: denied.targetId});
  }
  assert.ok(requests.some(r=>r.phase === "timing-denied" && r.url === "/nocors/blocked-master.m3u8" && r.status === 200 && !r.cookie),
    "negative control did not receive a CORS-blocked 200 probe");
  results.push("repeated CORS-negative timing captures refused");
  for (const via of ["playlist", "redirect"]) {
    const foreign = requests.find(r => r.phase === "hls.html" && r.url === "/public.aac?via=" + via);
    assert.ok(foreign && !foreign.cookie && !foreign.referer && foreign.origin !== pageOrigin,
      "Source headers or credentials leaked to another origin via " + via);
  }
  console.log(version.product, "→ 412/401 controls passed;", results.join("; "), "; foreign playlist/redirect clean");
} finally {
  if (call && browser.exitCode === null) await call("Browser.close").catch(() => browser.kill());
  if (exit) await exit;
  await Promise.all(servers.map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })));
  const resolved = await realpath(profile);
  if (path.dirname(resolved) !== temp || !path.basename(resolved).startsWith("shiliu-context-")) throw new Error("Unexpected profile path");
  await rm(resolved, {recursive: true, force: true, maxRetries: 8, retryDelay: 200});
}
