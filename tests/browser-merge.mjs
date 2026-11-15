// node tests/browser-merge.mjs <desktop Chrome or Edge executable>; requires ffmpeg and ffprobe on PATH.
// Optional --fragment-video and --ordinary-audio exercise alternate MP4 layouts.
// --page-json requires association from embedded per-clip JSON, with no URL vid.
// Uses only ephemeral profiles, loopback servers, and the browser's private CDP pipe.
import assert from "node:assert/strict";
import {execFileSync, spawn} from "node:child_process";
import {once} from "node:events";
import {mkdir, mkdtemp, readFile, realpath, rm, writeFile} from "node:fs/promises";
import {createServer} from "node:http";
import {tmpdir} from "node:os";
import path from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import {fileURLToPath} from "node:url";

const executable = process.argv[2];
const pageJson = process.argv.includes('--page-json');
const pageObserver = process.argv.includes('--page-observer');
const pageMetadata = pageJson || pageObserver;
if (!executable) throw new Error("Pass the path to a Chrome or Edge executable.");
const extension = fileURLToPath(new URL("../extension", import.meta.url));
const temp = await realpath(tmpdir());
const profile = await mkdtemp(path.join(temp, "shiliu-merge-"));
const requests = [];
const servers = [];
let phase = "control";

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


let browser, call, exit;
try {
  const fixtureDir = path.join(profile, 'generated-media');
  await mkdir(fixtureDir);
  const videoFile = path.join(fixtureDir, 'video.mp4');
  const audioFile = path.join(fixtureDir, 'audio.mp4');
  const completeFile = path.join(fixtureDir, 'complete.mp4');
  execFileSync('ffmpeg', ['-nostdin','-v','error','-f','lavfi','-i','testsrc2=size=96x64:rate=12:duration=2',
    '-an','-c:v','libx264','-pix_fmt','yuv420p','-preset','ultrafast',...(process.argv.includes('--fragment-video')?['-movflags','+frag_keyframe+empty_moov+default_base_moof']:[]),videoFile], {windowsHide:true});
  execFileSync('ffmpeg', ['-nostdin','-v','error','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=2',
    '-vn','-c:a','aac','-b:a','32k',...(process.argv.includes('--ordinary-audio')?[]:['-movflags','+frag_keyframe+empty_moov+default_base_moof']),audioFile], {windowsHide:true});
  const video = await readFile(videoFile), audio = await readFile(audioFile);
  execFileSync('ffmpeg',['-nostdin','-v','error','-i',videoFile,'-i',audioFile,'-map','0:v:0','-map','1:a:0','-c','copy',completeFile],{windowsHide:true});
  const complete = await readFile(completeFile);
  const clipMetadata = () => ({aweme_detail:{aweme_id:'7433333333333333333',video:{play_addr:{url_list:[videoUrl]},bit_rate_audio:[{audio_meta:{file_id:'fixture-audio',media_type:'audio',codec_type:'aac',format:'mp4',bitrate:32000,url_list:{main_url:audioUrl}}}]}},
    recommendations:[{aweme_id:'ambiguous123',video:{play_addr:{url_list:[ambiguousUrl]},bit_rate_audio:ambiguousAudio.map((url,index)=>({audio_meta:{file_id:'ambiguous-'+index,media_type:'audio',codec_type:'aac',format:'mp4',bitrate:32000,url_list:{main_url:url}}}))}}]});
  const pageLoopback = await serve((req,res) => {
    if (req.url.startsWith('/aweme/v1/web/aweme/detail/')) { res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(clipMetadata()));return; }
    res.writeHead(200, {'Content-Type':'text/html','Referrer-Policy':'origin',
      'Set-Cookie':'fixture_session=active; '+(pageMetadata?'Domain=fixture.iesdouyin.com; ':'')+'Path=/; SameSite=Lax; HttpOnly'});
    const endpoint = '/aweme/v1/web/aweme/detail/?aweme_id=7433333333333333333';
    const observerScript = process.argv.includes('--observer-xhr') ? `const request=new XMLHttpRequest();request.open('GET',${JSON.stringify(endpoint)});request.onload=()=>{window.fixtureMetadataLoaded=true};request.send();`
      : `fetch(${JSON.stringify(endpoint)}).then(r=>r.json()).then(()=>{window.fixtureMetadataLoaded=true})`;
    const metadata = pageJson ? '<script id="RENDER_DATA" type="application/json">'+encodeURIComponent(JSON.stringify(clipMetadata()))+'</script>'
      : pageObserver ? '<script>'+observerScript+'</script>' : '';
    res.end('<!doctype html><title>Merge fixture</title><video muted></video>'+metadata);
  });
  const pageHost = pageMetadata ? 'fixture.iesdouyin.com' : 'v26.douyinvod.com';
  const pageOrigin = pageLoopback.replace('127.0.0.1',pageHost);
  const cdnLoopback = await serve((req,res) => {
    const valid = req.headers.origin === pageOrigin && req.headers.referer === pageOrigin+'/' &&
      (req.headers.cookie || '').includes('fixture_session=active');
    requests.push({phase,url:req.url,status:valid ? 200 : 412,...req.headers});
    res.setHeader('Access-Control-Allow-Origin',pageOrigin);
    res.setHeader('Access-Control-Allow-Credentials','true');
    res.setHeader('Cache-Control','no-store');
    if (!valid) {res.writeHead(412);return res.end();}
    // The audio response deliberately lies about its MIME, as real split-track CDNs do.
    const body = req.url.startsWith('/complete.mp4') ? complete : new URL(req.url,cdn).searchParams.get('mime_type') === 'audio_mp4' ? audio : video;
    res.writeHead(200,{'Content-Type':'video/mp4','Content-Length':body.length});res.end(body);
  });
  const cdn = cdnLoopback.replace('127.0.0.1',pageMetadata ? 'cdn.fixture.iesdouyin.com' : 'v26.douyinvod.com');
  const videoUrl = cdn+'/video.mp4?'+(pageMetadata ? '' : 'vid=fixture123&')+'mime_type=video_mp4';
  const audioUrl = cdn+'/audio.mp4?'+(pageMetadata ? '' : 'vid=fixture123&')+'mime_type=audio_mp4';
  const unrelatedUrl = cdn+'/unrelated.mp4?vid=other456&mime_type=audio_mp4';
  const completeUrl = cdn+'/complete.mp4?vid=complete123&mime_type=video_mp4';
  const unpairedUrl = cdn+'/unpaired.mp4?vid=missing123&mime_type=video_mp4';
  const ambiguousUrl = cdn+'/ambiguous.mp4?vid=ambiguous123&mime_type=video_mp4';
  const ambiguousAudio = [1,2].map(n => cdn+`/ambiguous-${n}.mp4?vid=ambiguous123&mime_type=audio_mp4`);
  assert.equal((await fetch(audioUrl.replace(cdn,cdnLoopback))).status,412);
  browser = spawn(executable,['--headless=new','--no-first-run','--no-default-browser-check','--disable-sync',
    '--disable-background-networking','--disable-component-update','--remote-debugging-pipe',
    '--enable-unsafe-extension-debugging','--no-proxy-server','--host-resolver-rules=MAP v26.douyinvod.com 127.0.0.1,MAP fixture.iesdouyin.com 127.0.0.1,MAP cdn.fixture.iesdouyin.com 127.0.0.1','--user-data-dir='+profile,'about:blank'],
    {windowsHide:true,stdio:['ignore','ignore','ignore','pipe','pipe']});
  exit=once(browser,'exit');call=connect(browser);
  const version=await call('Browser.getVersion');
  const targets=async()=>(await call('Target.getTargets')).targetInfos;
  const attach=async targetId=>(await call('Target.attachToTarget',{targetId,flatten:true})).sessionId;
  const create=async url=>attach((await call('Target.createTarget',{url})).targetId);
  async function evaluate(session,expression) {
    const answer=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:true},session);
    if(answer.exceptionDetails) throw new Error(answer.exceptionDetails.exception?.description || answer.exceptionDetails.text);
    return answer.result.value;
  }
  const {id}=await call('Extensions.loadUnpacked',{path:extension});
  const extensionOrigin='chrome-extension://'+id;
  const worker=await until(async()=>(await targets()).find(t=>t.type==='service_worker'&&t.url===extensionOrigin+'/background.js'),'worker');
  const workerSession=await attach(worker.targetId);
  await until(()=>evaluate(workerSession,'chrome.webRequest.onHeadersReceived.hasListeners()'),'capture listeners');
  const player=await create(pageOrigin+'/watch');
  try { await until(()=>evaluate(player,"!!document.querySelector('video')"),'fixture page'); }
  catch (error) { throw new Error(error.message + ': ' + JSON.stringify(await evaluate(player,"({url:location.href,title:document.title,text:document.body?.innerText.slice(0,400)})"))); }
  if (pageObserver) await until(()=>evaluate(player,'window.fixtureMetadataLoaded===true'),'dynamic metadata response');
  phase='capture';
  await evaluate(player,`Promise.all(${JSON.stringify([videoUrl,audioUrl,unrelatedUrl,completeUrl,unpairedUrl,ambiguousUrl,...ambiguousAudio])}.map(url=>fetch(url,{credentials:'include'}).then(r=>r.arrayBuffer())))`);
  const popup=await create(extensionOrigin+'/popup.html');
  await until(()=>evaluate(popup,"!!globalThis.chrome?.tabs && !!document.querySelector('#refresh') && !document.querySelector('#refresh').disabled"),'popup loaded');
  const tabId=await evaluate(popup,`chrome.tabs.query({url:${JSON.stringify(pageOrigin+'/watch')}}).then(t=>t[0].id)`);
  await evaluate(popup,`chrome.runtime.sendMessage({type:'LIST_MEDIA',tabId:${tabId}})`);
  const stored=await evaluate(popup,`chrome.storage.session.get('media:'+${tabId}).then(s=>s['media:'+${tabId}].items)`);
  const videoId=stored.find(i=>i.url===videoUrl)?.id, audioId=stored.find(i=>i.url===audioUrl)?.id;
  assert.ok(videoId && audioId,'split tracks captured');
  await evaluate(popup,`chrome.tabs.update(${tabId},{active:true}).then(()=>document.querySelector('#refresh').click())`);
  await until(()=>evaluate(popup,`!![...document.querySelectorAll('.media-row')].find(r=>r.dataset.item===${JSON.stringify(videoId)})?.querySelector('.action')`),'video action');
  const clicked=await evaluate(popup,`(()=>{const row=[...document.querySelectorAll('.media-row')].find(r=>r.dataset.item===${JSON.stringify(videoId)});const b=row?.querySelector('.action');b?.click();return !!b})()`);
  assert.ok(clicked,'video row has merge action');
  const target=await until(async()=>(await targets()).find(t=>t.url.startsWith(extensionOrigin+'/merge.html#')),'merge page');
  const session=await attach(target.targetId);
  await until(()=>evaluate(session,"document.querySelector('#start')?.disabled===false"),'merge readiness');
  assert.equal(new URLSearchParams(new URL(target.url).hash.slice(1)).get('mode'),'auto');
  assert.equal(await evaluate(session,"document.querySelector('#tracks').hidden"),true,'normal download never asks user to choose tracks');
  const unrelatedId=stored.find(i=>i.url===unrelatedUrl)?.id;
  assert.notEqual(audioId,unrelatedId);
  phase='merge';
  assert.equal(await evaluate(popup,`fetch(${JSON.stringify(audioUrl)},{credentials:'include',referrerPolicy:'no-referrer'}).then(r=>r.status)`),412,
    'unrelated extension tab cannot reuse source context');
  // Replace only the OS modal. Output still passes through a native file writable.
  await evaluate(session,`window.showSaveFilePicker=async({suggestedName})=>{const dir=await navigator.storage.getDirectory();return window.fixtureHandle=await dir.getFileHandle(suggestedName,{create:true})};document.querySelector('#start').click()`);
  await until(async()=>{const error=await evaluate(session,"document.querySelector('#status.error')?.textContent");if(error)throw new Error(error);return evaluate(session,"document.querySelector('#status')?.textContent.startsWith('已保存')")},'merged save');
  const bytes=Buffer.from(await evaluate(session,'fixtureHandle.getFile().then(f=>f.arrayBuffer()).then(b=>Array.from(new Uint8Array(b)))'));
  const output=path.join(fixtureDir,'merged.mp4');await writeFile(output,bytes);
  const report=JSON.parse(execFileSync('ffprobe',['-v','error','-count_frames','-show_entries','stream=codec_name,codec_type,width,height,duration,nb_read_frames:format=duration','-of','json',output],{encoding:'utf8',windowsHide:true}));
  const v=report.streams.find(s=>s.codec_type==='video'),a=report.streams.find(s=>s.codec_type==='audio');
  assert.equal(v?.codec_name,'h264');assert.equal(a?.codec_name,'aac');assert.equal(v.width,96);assert.equal(v.height,64);
  assert.equal(Number(v.nb_read_frames),24);assert.ok(Number(a.nb_read_frames)>=90);
  assert.ok(Math.abs(Number(report.format.duration)-2)<0.15);
  execFileSync('ffmpeg',['-nostdin','-v','error','-xerror','-i',output,'-map','0:v','-map','0:a','-f','null','-'],{windowsHide:true});
  if (process.platform === 'win32') {
    const native = JSON.parse(execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      fileURLToPath(new URL('./native-playback.ps1', import.meta.url)), output], {encoding:'utf8', windowsHide:true}));
    assert.equal(native[0]?.Ok, true, 'Windows Media Foundation decodes and seeks both tracks');
  }
  const controlFile=path.join(fixtureDir,'ffmpeg-control.mp4');
  execFileSync('ffmpeg',['-nostdin','-v','error','-i',videoFile,'-i',audioFile,'-map','0:v:0','-map','1:a:0','-c','copy',controlFile],{windowsHide:true});
  async function playback(label, data) {
    return evaluate(session,`(async()=>{
      const v=document.createElement('video');v.muted=true;v.style.width='96px';v.style.height='64px';document.body.append(v);
      const blob=new Blob([Uint8Array.from(atob(${JSON.stringify(data.toString('base64'))}),c=>c.charCodeAt(0))],{type:'video/mp4'});
      const url=URL.createObjectURL(blob);const result={label:${JSON.stringify(label)}};
      const wait=async(event)=>Promise.race([new Promise((resolve,reject)=>{v.addEventListener(event,resolve,{once:true});v.addEventListener('error',()=>reject(new Error('MediaError '+v.error?.code+': '+v.error?.message)),{once:true})}),new Promise((_,reject)=>setTimeout(()=>reject(new Error('timeout '+event)),5000))]);
      try {const ready=wait('loadeddata');v.src=url;await ready;result.duration=v.duration;result.width=v.videoWidth;
        await v.play();await new Promise(resolve=>setTimeout(resolve,350));result.decodedBeforeSeek=v.getVideoPlaybackQuality().totalVideoFrames;
        const sought=wait('seeked');v.currentTime=Math.max(0,v.duration-0.4);await sought;const ended=wait('ended');await v.play();await ended;
        result.decodedFrames=v.getVideoPlaybackQuality().totalVideoFrames;result.currentTime=v.currentTime;result.error=v.error?.message||null;
      }catch(error){result.error=error.message;result.mediaError=v.error?{code:v.error.code,message:v.error.message}:null;}
      finally{v.pause();v.remove();URL.revokeObjectURL(url)}return result;
    })()`);
  }
  const playbackReports=[];
  for(const [label,data] of [['source-video',video],['ffmpeg-control',await readFile(controlFile)],['merged',bytes]])playbackReports.push(await playback(label,data));
  console.log('HTMLVideoElement',JSON.stringify(playbackReports));
  for(const result of playbackReports){assert.equal(result.error,null,result.label+' playback: '+JSON.stringify(result));assert.ok(result.decodedBeforeSeek>0);assert.ok(result.decodedFrames>0);assert.equal(result.width,96);assert.ok(Math.abs(result.duration-2)<0.15);assert.ok(result.currentTime>=result.duration-0.1);}
  for(const url of [videoUrl,audioUrl])assert.ok(requests.some(r=>r.phase==='merge'&&r.url===new URL(url).pathname+new URL(url).search&&r.status===200),'authorized track fetched');
  assert.ok(!requests.some(r=>r.phase==='merge'&&r.url.startsWith('/unrelated.mp4')),'unrelated track never fetched');
  phase='picker-cancel';
  await until(()=>evaluate(session,"!document.querySelector('#start').disabled"),'start reset');
  await evaluate(session,`window.showSaveFilePicker=async()=>{throw new DOMException('Fixture canceled','AbortError')};document.querySelector('#start').click()`);
  await until(()=>evaluate(session,"document.querySelector('#status').textContent==='已取消下载。'"),'picker cancellation');
  assert.ok(!requests.some(r=>r.phase==='picker-cancel'),'canceling picker never downloads tracks');
  await call('Target.closeTarget',{targetId:target.targetId});
  await until(()=>evaluate(popup,'chrome.declarativeNetRequest.getSessionRules().then(r=>r.length===0)'),'merge rule cleanup');
  for (const [name,url] of [['complete',completeUrl],['missing',unpairedUrl],['ambiguous',ambiguousUrl]]) {
    phase=name;
    const anchorId=stored.find(item=>item.url===url)?.id;assert.ok(anchorId);
    const auto=await create(extensionOrigin+'/merge.html#'+new URLSearchParams({tab:String(tabId),item:anchorId,mode:'auto'}));
    await until(()=>evaluate(auto,"document.querySelector('#start')?.disabled===false"),name+' readiness');
    await evaluate(auto,`window.showSaveFilePicker=async({suggestedName})=>{const dir=await navigator.storage.getDirectory();return window.fixtureHandle=await dir.getFileHandle(suggestedName,{create:true})};document.querySelector('#start').click()`);
    if(name==='complete') {
      await until(()=>evaluate(auto,"document.querySelector('#status').textContent.startsWith('已保存')"),'complete video save');
      const preserved=Buffer.from(await evaluate(auto,'fixtureHandle.getFile().then(f=>f.arrayBuffer()).then(b=>Array.from(new Uint8Array(b)))'));
      assert.deepEqual(preserved,complete,'existing audio/video file saved byte-for-byte');
      assert.ok(!requests.some(r=>r.phase===name && /audio_mp4/.test(r.url)),'complete video does not fetch any additional audio');
    } else {
      await until(()=>evaluate(auto,"document.querySelector('#status.error')?.textContent.includes('重新扫描')"),name+' safe failure');
      assert.ok(!requests.some(r=>r.phase===name && /audio_mp4/.test(r.url)),name+' never guesses an audio candidate');
      assert.equal(await evaluate(auto,'fixtureHandle.getFile().then(f=>f.size)'),0,'failure never commits incomplete video');
    }
    await until(()=>evaluate(auto,"!document.querySelector('#start').disabled"),name+' cleanup finished');
    assert.equal(await evaluate(auto,"navigator.storage.getDirectory().then(async dir=>{let count=0;for await(const name of dir.keys())if(name.startsWith('shiliu-merge-'))count++;return count})"),0,'temporary downloads cleaned');
    const autoTarget=await evaluate(auto,'chrome.tabs.getCurrent().then(t=>t.id)');
    await evaluate(popup,`chrome.tabs.remove(${autoTarget})`);
    await until(()=>evaluate(popup,'chrome.declarativeNetRequest.getSessionRules().then(r=>r.length===0)'),name+' rule cleanup');
  }
  phase='auto-write-cancel';
  const cancelSession=await create(extensionOrigin+'/merge.html#'+new URLSearchParams({tab:String(tabId),item:videoId,mode:'auto'}));
  await until(()=>evaluate(cancelSession,"document.querySelector('#start')?.disabled===false"),'cancel readiness');
  await evaluate(cancelSession,`window.showSaveFilePicker=async()=>{
    const dir=await navigator.storage.getDirectory(),handle=await dir.getFileHandle('cancel-existing.mp4',{create:true});
    const seed=await handle.createWritable();await seed.write('previous file');await seed.close();window.fixtureHandle=handle;
    return {name:handle.name,async createWritable(options){const native=await handle.createWritable(options);return new WritableStream({
      async write(chunk){await native.write(chunk);document.querySelector('#cancel').click()},
      close(){return native.close()},abort(){return native.abort()}})}}};document.querySelector('#start').click()`);
  await until(()=>evaluate(cancelSession,"document.querySelector('#status').textContent==='已取消下载。'"),'cancel during final native write');
  await until(()=>evaluate(cancelSession,"!document.querySelector('#start').disabled"),'cancel cleanup finished');
  assert.equal(await evaluate(cancelSession,'fixtureHandle.getFile().then(f=>f.text())'),'previous file','cancel during commit rolls back previous file');
  assert.equal(await evaluate(cancelSession,"navigator.storage.getDirectory().then(async dir=>{let count=0;for await(const name of dir.keys())if(name.startsWith('shiliu-merge-'))count++;return count})"),0,'cancel cleans temporary tracks');
  const cancelTab=await evaluate(cancelSession,'chrome.tabs.getCurrent().then(t=>t.id)');await evaluate(popup,`chrome.tabs.remove(${cancelTab})`);
  await until(()=>evaluate(popup,'chrome.declarativeNetRequest.getSessionRules().then(r=>r.length===0)'),'cancel rule cleanup');
  console.log(version.product,'→ split-track pairing, isolated context, H264 + AAC merged MP4 decode/play/seek passed;',bytes.length,'bytes');
} finally {
  if(call && browser.exitCode===null)await call('Browser.close').catch(()=>browser.kill());
  if(exit)await exit;
  await Promise.all(servers.map(server=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections()})));
  const resolved=await realpath(profile);
  if(path.dirname(resolved)!==temp||!path.basename(resolved).startsWith('shiliu-merge-'))throw new Error('Unexpected profile path');
  await rm(resolved,{recursive:true,force:true,maxRetries:8,retryDelay:200});
}
