import './media-pairing.js';
import {streamFile} from './file-core.js';
import {fetchMedia} from './media-request.js';
import {inspectMp4, mergeMp4} from './mp4-merge.js';
import {automaticVideo, validatePair} from './auto-download.js';

const el = Object.fromEntries([...document.querySelectorAll('[id]')].map(node => [node.id, node]));
const params = new URLSearchParams(location.hash.slice(1));
const tabId = Number(params.get('tab'));
const automatic = params.get('mode') === 'auto';
if (automatic) el.tracks.hidden = true;
let items = [];
let anchor;
let controller;
const status = (message, error = false) => {
  el.status.textContent = message;
  el.status.classList.toggle('error', error);
};
function update() {
  if (automatic) { el.start.disabled = Boolean(controller) || !anchor; return; }
  const video = el['video-track'].value;
  const audio = el['audio-track'].value;
  el.start.disabled = Boolean(controller) || !video || !audio || video === audio;
  const paired = items.find(item => item.id === video)?.mergeAudioId === audio;
  el['pair-note'].textContent = paired ? '已根据同一视频的标识选中对应音轨。保存前还会检查实际轨道。'
    : '无法确认自动配对，请选择同一段视频对应的声音。下载时会检查实际轨道和时长。';
}
function options(select, preferred) {
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '请选择资源';
  select.replaceChildren(placeholder);
  items.forEach((item, i) => {
    const option = document.createElement('option');
    option.value = item.id;
    const kind = ShiliuPairing.classify(item).track === 'audio' ? '音频' : '视频';
    const size = item.size ? ' · ' + (item.size / 1048576).toFixed(1) + ' MiB' : '';
    option.textContent = `${i + 1}. ${item.name} · ${kind}${size}`;
    select.append(option);
  });
  select.value = preferred || '';
  select.disabled = false;
  select.addEventListener('change', update);
}

async function receive(id, directory, name, label, signal) {
  // Prepare one exact source immediately before fetching it. The per-tab source
  // rule is replaced only after the preceding response has finished streaming.
  const prepared = await chrome.runtime.sendMessage({type: 'GET_MERGE_MEDIA', tabId, id});
  if (!prepared?.ok) throw new Error(prepared?.error || '资源已失效，请重新扫描。');
  signal.throwIfAborted();
  const file = await directory.getFileHandle(name, {create: true});
  const writable = await file.createWritable();
  try {
    const response = await fetchMedia(prepared.item.url, signal, prepared.credentialOrigin);
    let last = -Infinity;
    await streamFile(response, writable, prepared.item.kind, (done, total) => {
      if (performance.now() - last < 200 && done !== total) return;
      last = performance.now();
      if (total) { el.bar.max = total; el.bar.value = done; }
      else el.bar.removeAttribute('value');
      status(`${label}：已接收 ${(done / 1048576).toFixed(1)} MiB`);
    }, signal);
    await writable.close();
    return file.getFile();
  } catch (error) {
    await writable.abort().catch(() => {});
    throw error;
  }
}

async function download() {
  if (controller || el.start.disabled) return;
  const videoId = automatic ? anchor.id : el['video-track'].value;
  const audioId = el['audio-track'].value;
  const selected = items.find(item => item.id === videoId);
  controller = new AbortController();
  const signal = controller.signal;
  update();
  el['video-track'].disabled = el['audio-track'].disabled = true;
  let root, directoryName, writable, handle;
  try {
    const suggestedName = (selected.name || '视频').replace(/\.[^.]+$/, '') + (automatic ? '' : '-有声') + '.mp4';
    handle = await window.showSaveFilePicker({id: 'merged-media-export', startIn: 'downloads', suggestedName,
      types: [{description: 'MP4 视频', accept: {'video/mp4': ['.mp4']}}]});
    el.cancel.hidden = false;
    el.cancel.disabled = false;
    el.bar.hidden = false;
    el.bar.removeAttribute('value');
    root = await navigator.storage.getDirectory();
    directoryName = 'shiliu-merge-' + crypto.randomUUID();
    const directory = await root.getDirectoryHandle(directoryName, {create: true});
    let merged, didMerge = false;
    if (automatic) {
      const result = await automaticVideo({videoId, signal,
        receive: (id, label) => receive(id, directory, id === videoId ? 'video.mp4' : 'audio.mp4', label, signal),
        inspect: inspectMp4,
        pair: id => chrome.runtime.sendMessage({type: 'GET_AUTO_PAIR', tabId, id}),
        merge: mergeMp4,
        onStage(stage) {
          const messages = {inspect: '正在检查视频是否包含声音…', pair: '正在识别对应音轨…', merge: '正在无损合并画面与声音…'};
          if (messages[stage]) { status(messages[stage]); el.bar.removeAttribute('value'); }
        }});
      merged = result.file; didMerge = result.merged;
    } else {
    let video = await receive(videoId, directory, 'video.mp4', '正在下载画面来源', signal);
    let audio = await receive(audioId, directory, 'audio.mp4', '正在下载声音来源', signal);
    status('正在检查实际视频和音频轨道…');
    let videoInfo = await inspectMp4(video, {signal});
    let audioInfo = await inspectMp4(audio, {signal});
    const only = (info, kind) => info.tracks.length === 1 && info.tracks[0].kind === kind;
    if (only(videoInfo, 'audio') && only(audioInfo, 'video')) {
      [video, audio] = [audio, video];
      [videoInfo, audioInfo] = [audioInfo, videoInfo];
    }
    validatePair(videoInfo, audioInfo);
    status('正在无损合并画面与声音…');
    el.bar.removeAttribute('value');
    merged = await mergeMp4(video, audio, {signal}); didMerge = true;
    }
    signal.throwIfAborted();
    writable = await handle.createWritable({mode: 'exclusive'});
    status('正在保存 MP4…');
    await merged.stream().pipeTo(writable, {signal, preventClose: true, preventAbort: true});
    signal.throwIfAborted();
    await writable.close();
    writable = null;
    status('已保存「' + handle.name + '」，' + (didMerge ? '已自动合并画面和声音。' : '原视频已包含声音。'));
  } catch (error) {
    if (writable) await writable.abort().catch(() => {});
    const canceled = signal.aborted || (!handle && error.name === 'AbortError');
    const message = error.name === 'QuotaExceededError' ? '浏览器临时存储空间不足，请释放磁盘空间后重试。'
      : error instanceof TypeError ? '媒体连接中断，请在原网页重新播放并扫描最新地址。'
      : error.message || '合并失败，请重新选择资源。';
    status(canceled ? (automatic ? '已取消下载。' : '已取消合并下载。') : message, !canceled);
  } finally {
    if (root && directoryName) await root.removeEntry(directoryName, {recursive: true}).catch(() => {});
    controller = null;
    el.bar.hidden = true;
    el.cancel.hidden = true;
    el['video-track'].disabled = el['audio-track'].disabled = false;
    update();
  }
}

el.start.addEventListener('click', download);
el.cancel.addEventListener('click', () => { controller?.abort(); el.cancel.disabled = true; status('正在取消…'); });
window.addEventListener('beforeunload', event => {
  if (controller) { event.preventDefault(); event.returnValue = ''; }
});
async function initialize() {
  try {
    if (!window.showSaveFilePicker || !navigator.storage?.getDirectory) throw new Error('请使用桌面版 Chrome 或 Edge 打开合并页。');
    if (!/^\d+$/.test(params.get('tab') || '') || !params.get('item')) throw new Error('请从拾流资源列表打开合并页。');
    const result = await chrome.runtime.sendMessage({type: 'LIST_MEDIA', tabId});
    if (!result?.ok) throw new Error(result?.error || '无法读取资源列表。');
    items = result.items.filter(item => ShiliuPairing.isMp4(item));
    anchor = items.find(item => item.id === params.get('item'));
    if (!anchor) throw new Error('原网页已更新，请重新扫描。');
    if (automatic) {
      el.tracks.hidden = true;
      el.heading.textContent = '下载视频';
      el['source-heading'].textContent = anchor.name || '视频';
      el.site.textContent = '自动检查实际声音，必要时合并对应音轨，保留原始画质。';
      el.start.textContent = '选择位置并下载';
      el['save-hint'].textContent = '下载时请保持此页打开。临时文件在完成或取消后清理。';
      update(); status('选择保存位置后，将自动检查并保存有声视频。'); return;
    }
    const anchorAudio = ShiliuPairing.classify(anchor).track === 'audio';
    options(el['video-track'], anchorAudio ? '' : anchor.id);
    options(el['audio-track'], anchorAudio ? anchor.id : anchor.mergeAudioId);
    update();
    status('选好画面和声音来源后，选择保存位置即可合并下载。');
  } catch (error) { status(error.message || '无法打开合并页。', true); }
}
initialize();
