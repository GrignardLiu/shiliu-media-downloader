// node tests/browser-context.mjs <desktop Chrome or Edge executable>
// Uses only ephemeral profiles, loopback servers, and the browser's private CDP pipe.
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {mkdtemp, realpath, rm} from "node:fs/promises";
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
  const pageOrigin = await serve((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (req.url.startsWith("/public.aac")) {
      requests.push({phase, url: req.url, ...req.headers});
      res.writeHead(200, {"Content-Type": "audio/aac"});
      return res.end(aac);
    }
    res.writeHead(200, {"Content-Type": "text/html", "Referrer-Policy": "origin",
      "Set-Cookie": "fixture_session=active; Path=/; SameSite=Lax; HttpOnly"});
    res.end("<!doctype html><title>Local media fixture</title><audio muted></audio>");
  });
  const cdn = await serve((req, res) => {
    const headers = req.headers;
    const validContext = headers.origin === pageOrigin && headers.referer === pageOrigin + "/";
    const session = (headers.cookie || "").includes("fixture_session=active");
    let status = validContext ? (session || req.url === "/redirect.aac" ? 200 : 401) : 412;
    res.setHeader("Access-Control-Allow-Origin", pageOrigin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Cache-Control", "no-store");
    if (status === 200 && req.url === "/redirect.aac") status = 302;
    requests.push({phase, url: req.url, status, ...headers});
    if (status === 302) { res.writeHead(302, {Location: pageOrigin + "/public.aac?via=redirect"}); return res.end(); }
    if (status !== 200) { res.writeHead(status); return res.end(); }
    const media = {
      "/master.m3u8": ["application/vnd.apple.mpegurl", "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=64000\ntrack.m3u8"],
      "/track.m3u8": ["application/vnd.apple.mpegurl", "#EXTM3U\n#EXTINF:0.1,\nsound.aac\n#EXTINF:0.1,\n" +
        pageOrigin + "/public.aac?via=playlist\n#EXTINF:0.1,\nredirect.aac\n#EXT-X-ENDLIST"],
      "/sound.aac": ["audio/aac", aac], "/sample.wav": ["audio/wav", wav]
    }[req.url];
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
  const {id} = await call("Extensions.loadUnpacked", {path: extension});
  const extensionOrigin = "chrome-extension://" + id;
  const targets = async () => (await call("Target.getTargets")).targetInfos;
  const attach = async targetId => (await call("Target.attachToTarget", {targetId, flatten: true})).sessionId;
  const create = async url => attach((await call("Target.createTarget", {url})).targetId);
  async function evaluate(session, expression) {
    const answer = await call("Runtime.evaluate", {expression, returnByValue: true, awaitPromise: true, userGesture: true}, session);
    if (answer.exceptionDetails) throw new Error(answer.exceptionDetails.exception?.description || answer.exceptionDetails.text);
    return answer.result.value;
  }

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
    for (const part of ["/master.m3u8", "/track.m3u8", "/sound.aac"]) await fetchMedia(part);
    return player.readyState >= 2;
  })()`);
  assert.equal(played, true);
  const popup = await create(extensionOrigin + "/popup.html");
  await until(() => evaluate(popup, "!!document.querySelector('#refresh') && !document.querySelector('#refresh').disabled"), "extension popup");
  const srcId = await evaluate(popup, `chrome.tabs.query({url:${JSON.stringify(pageOrigin + "/watch")}}).then(t=>t[0].id)`);
  await evaluate(popup, `chrome.tabs.update(${srcId}, {active:true}).then(() => document.querySelector("#refresh").click())`);
  await until(() => evaluate(popup, "document.querySelectorAll('.media-row').length >= 2"), "captured media rows");
  const results = [];
  for (const [name, page, expected] of [["master.m3u8", "hls.html", Buffer.concat([aac, aac, aac])], ["sample.wav", "file.html", wav]]) {
    phase = page;
    const clicked = await evaluate(popup, `(() => {
      const row = [...document.querySelectorAll(".media-row")].find(r=>r.querySelector(".media-title").textContent===${JSON.stringify(name)});
      if (!row) return false;
      row.querySelector("button").click();return true;
    })()`);
    assert.ok(clicked, name + " missing in popup");
    const target = await until(async () => (await targets()).find(t=>t.url.startsWith(extensionOrigin + "/" + page + "#")), page);
    const session = await attach(target.targetId);
    await until(async () => {
      const message = await evaluate(session, "document.querySelector('#status.error')?.textContent");
      if (message) throw new Error(page + ": " + message);
      return evaluate(session, "document.querySelector('#start')?.disabled === false");
    }, page + " preparation");
    // An unrelated extension tab cannot reuse this download's origin/referrer rule.
    const otherTabStatus = await evaluate(popup, `fetch(${JSON.stringify(cdn + "/" + name)},
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
    assert.deepEqual(Buffer.from(saved), expected);
    results.push(page + "=" + saved.length + " verified bytes");
    await call("Target.closeTarget", {targetId: target.targetId});
    await until(() => evaluate(popup, "chrome.declarativeNetRequest.getSessionRules().then(r=>r.length===0)"), "rule cleanup");
  }
  for (const route of ["/master.m3u8", "/track.m3u8", "/sound.aac", "/sample.wav"]) {
    assert.ok(requests.some(r => r.phase.endsWith(".html") && r.url === route && r.status === 200), route + " context missing");
  }
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
