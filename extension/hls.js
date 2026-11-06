import {appendSegment, checkSegment, fileStem, httpUrl, loadPlaylist, readResource} from "./hls-core.js";

const el = Object.fromEntries([...document.querySelectorAll("[id]")].map(node => [node.id, node]));
let resource;
let options = [];
let playlist;
let format;
let firstPart;
let controller;

function status(message, error = false) {
  el.status.textContent = message;
  el.status.classList.toggle("error", error);
}

function errorText(error) {
  if (error instanceof TypeError) return "网络请求失败。请确认链接仍可访问，或回到原网页重新播放。";
  if (["SecurityError", "NotAllowedError"].includes(error.name)) return "浏览器未允许保存文件。请在桌面版 Chrome 或 Edge 中重新选择可写入的位置。";
  if (error.name === "QuotaExceededError") return "写入空间不足。请释放磁盘空间或选择其他位置。";
  if (["NotFoundError", "NoModificationAllowedError", "NotReadableError"].includes(error.name)) {
    return "无法写入所选文件，请检查文件占用、磁盘空间或选择其他位置。";
  }
  return error.message || "操作失败，请重试。";
}

function setBusy(busy) {
  el.start.disabled = busy || !playlist;
  el.track.disabled = busy;
  el.cancel.hidden = !controller || !busy;
  el.cancel.disabled = false;
}

async function preparePlaylist(value) {
  const signal = controller.signal;
  status("正在检查分片格式…");
  // Determine the extension before the next click so the file picker can open
  // under that click's user activation, with the correct suggested filename.
  const first = value.init || value.segments[0];
  const blob = await fetchPart(first, signal);
  const checked = await checkSegment(blob, value.init ? "init" : "media", selectedAudio(), signal);
  signal.throwIfAborted();
  firstPart = checked.blob;
  format = {ext: checked.ext, mime: checked.mime};
  playlist = value;
  const seconds = Math.round(value.duration);
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor(seconds / 60) % 60;
  const time = [hours || null, hours ? String(mins).padStart(2, "0") : mins,
    String(seconds % 60).padStart(2, "0")].filter(v => v !== null).join(":");
  el.summary.textContent = format.ext.toUpperCase() + "　·　时长 " + time + "　·　" + value.segments.length + " 个分片";
  el.summary.hidden = false;
  status("选择保存位置即可开始下载。");
}

function selectedAudio() {
  return options[el.track.selectedIndex]?.audio || false;
}

async function loadSelection() {
  const selected = options[el.track.selectedIndex];
  const parsed = await loadPlaylist(selected.url, controller.signal);
  if (parsed.options) throw new Error("暂不支持嵌套的多级主清单。");
  await preparePlaylist(parsed);
}

async function readSelection(refreshRoot) {
  playlist = null;
  firstPart = null;
  format = null;
  controller = new AbortController();
  el.summary.hidden = true;
  el.retry.hidden = true;
  el.bar.hidden = true;
  setBusy(true);
  status("正在读取播放列表…");
  try {
    if (refreshRoot) {
      options = [];
      el.tracks.hidden = true;
      const parsed = await loadPlaylist(resource.url, controller.signal);
      if (!parsed.options) {
        await preparePlaylist(parsed);
        return;
      }
      options = parsed.options;
      el.track.replaceChildren(...options.map((track, i) => new Option(track.label, String(i))));
      el["track-hint"].hidden = !options.some(item => item.audio);
      el.tracks.hidden = false;
    }
    await loadSelection();
  } catch (error) {
    const canceled = controller.signal.aborted;
    status(canceled ? "已取消读取。" : errorText(error), !canceled);
    el.retry.hidden = false;
  } finally {
    controller = null;
    setBusy(false);
  }
}

async function fetchPart(part, signal) {
  for (let attempt = 0; ; attempt++) {
    try {
      return (await readResource(part, signal)).blob;
    } catch (error) {
      if (signal.aborted || attempt >= 2 || (!error.retryable && !(error instanceof TypeError))) throw error;
      status("分片请求中断，正在重试（" + (attempt + 1) + "/2）…");
      await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
      signal.throwIfAborted();
    }
  }
}

function suggestedName() {
  const selected = options[el.track.selectedIndex];
  const suffix = selected ? " - " + fileStem(selected.label) : "";
  return fileStem(resource.name) + suffix.slice(0, 52).trimEnd() + "." + format.ext;
}

async function saveParts(writable, signal) {
  let bytes = 0;
  // The initialization part, when present, is written once before segment zero.
  const firstIndex = playlist.init ? -1 : 0;
  const stage = playlist.init && format.ext !== "ts" ? "fragment" : "media";
  for (let index = firstIndex; index < playlist.segments.length; index++) {
    signal.throwIfAborted();
    let data;
    if (index === firstIndex && firstPart) {
      data = firstPart;
      firstPart = null;
    } else {
      const init = index === -1;
      const part = init ? playlist.init : playlist.segments[index];
      const blob = await fetchPart(part, signal);
      const checked = await checkSegment(blob, init ? "init" : stage, selectedAudio(), signal);
      if (checked.ext !== format.ext) throw new Error("分片使用了不同的封装格式，无法合并。");
      data = checked.blob;
    }
    bytes = await appendSegment(writable, data, bytes, signal);
    el.bar.value = index + 1;
    status("已写入 " + (index + 1) + " / " + playlist.segments.length +
      " 个分片，" + (bytes / (1024 * 1024)).toFixed(1) + " MiB");
  }
}

async function download() {
  let writable;
  let handle;
  controller = new AbortController();
  const signal = controller.signal;
  setBusy(true);
  el.cancel.hidden = true;
  el.bar.hidden = true;
  try {
    // This must be the first awaited call from the user's click.
    handle = await window.showSaveFilePicker({
      id: "hls-export", startIn: "downloads", suggestedName: suggestedName(),
      types: [{description: format.ext.toUpperCase() + " 媒体文件", accept: {[format.mime]: ["." + format.ext]}}]
    });
    writable = await handle.createWritable({mode: "exclusive"});
    el.bar.max = playlist.segments.length;
    el.bar.value = 0;
    el.bar.hidden = false;
    el.cancel.hidden = false;
    status("正在写入媒体分片…");
    await saveParts(writable, signal);
    signal.throwIfAborted();
    el.cancel.hidden = true;
    status("正在完成保存…");
    await writable.close();
    writable = null;
    status("已保存「" + handle.name + "」。");
  } catch (error) {
    if (writable) await writable.abort().catch(() => {});
    const canceled = signal.aborted || (!handle && error.name === "AbortError");
    status(canceled ? "已取消下载。" : errorText(error), !canceled);
    el.bar.hidden = true;
  } finally {
    controller = null;
    setBusy(false);
  }
}

el.track.addEventListener("change", () => readSelection(false));
el.retry.addEventListener("click", () => readSelection(!options.length));
el.start.addEventListener("click", download);
el.cancel.addEventListener("click", () => {
  controller?.abort();
  el.cancel.disabled = true;
  status("正在取消…");
});

async function initialize() {
  try {
    if (typeof window.showSaveFilePicker !== "function") {
      throw new Error("当前浏览器未提供本地文件保存功能。请使用桌面版 Chrome 或 Edge 打开下载页。");
    }
    const params = new URLSearchParams(location.hash.slice(1));
    const tab = params.get("tab");
    const id = params.get("item");
    if (!/^\d+$/.test(tab || "") || !id) throw new Error("请从拾流的页面资源列表打开 HLS 下载。");
    const result = await chrome.runtime.sendMessage({type: "GET_MEDIA", tabId: Number(tab), id});
    if (!result?.ok || result.item?.kind !== "hls") throw new Error("该资源已失效。请在原网页重新扫描并打开。");
    resource = {url: httpUrl(result.item.url), name: result.item.name || "媒体"};
    el.title.textContent = resource.name;
    el.site.textContent = new URL(resource.url).host;
    await readSelection(true);
  } catch (error) {
    el.title.textContent = "无法打开资源";
    status(errorText(error), true);
  }
}

initialize();
