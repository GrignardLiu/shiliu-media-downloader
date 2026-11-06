import {streamFile} from "./file-core.js";
import {fetchMedia} from "./media-request.js";

const el = Object.fromEntries([...document.querySelectorAll("[id]")].map(node => [node.id, node]));
let media;
let credentialOrigin;
let controller;

function status(message, error = false) {
  el.status.textContent = message;
  el.status.classList.toggle("error", error);
}

async function download() {
  if (controller || !media) return;
  controller = new AbortController();
  const signal = controller.signal;
  el.start.disabled = true;
  el.bar.hidden = true;
  let handle;
  let writable;
  try {
    handle = await window.showSaveFilePicker({id: "media-export", startIn: "downloads", suggestedName: media.name});
    el.cancel.hidden = false;
    el.cancel.disabled = false;
    status("正在连接媒体服务器…");
    writable = await handle.createWritable({mode: "exclusive"});
    const response = await fetchMedia(media.url, signal, credentialOrigin);
    let lastUpdate = -Infinity;
    el.bar.removeAttribute("value");
    el.bar.hidden = false;
    await streamFile(response, writable, media.kind, (done, total) => {
      if (performance.now() - lastUpdate < 200 && done !== total) return;
      lastUpdate = performance.now();
      if (total) {
        el.bar.max = total;
        el.bar.value = done;
      }
      status("已接收 " + (done / (1024 * 1024)).toFixed(1) + " MiB");
    }, signal);
    signal.throwIfAborted();
    el.cancel.hidden = true;
    status("正在完成保存…");
    await writable.close();
    writable = null;
    status("已保存「" + handle.name + "」。");
  } catch (error) {
    if (writable) await writable.abort().catch(() => {});
    const canceled = signal.aborted || (!handle && error.name === "AbortError");
    const message = error instanceof TypeError
      ? "连接中断或媒体地址已跳转。请回到原网页重新播放，再打开最新资源。"
      : ["NotAllowedError", "SecurityError"].includes(error.name) ? "浏览器未允许写入，请重新选择保存位置。"
      : error.message || "下载失败，请重试。";
    status(canceled ? "已取消下载。" : message, !canceled);
    el.bar.hidden = true;
  } finally {
    controller = null;
    el.start.disabled = false;
    el.cancel.hidden = true;
  }
}

el.start.addEventListener("click", download);
el.cancel.addEventListener("click", () => {
  controller?.abort();
  el.cancel.disabled = true;
  status("正在取消…");
});

async function initialize() {
  try {
    if (!window.showSaveFilePicker) throw new Error("请使用桌面版 Chrome 或 Edge 打开下载页。");
    const params = new URLSearchParams(location.hash.slice(1));
    const tab = params.get("tab");
    const id = params.get("item");
    if (!/^\d+$/.test(tab || "") || !id) throw new Error("请从拾流的资源列表打开文件。");
    const result = await chrome.runtime.sendMessage({type: "GET_MEDIA", tabId: Number(tab), id});
    if (!result?.ok || !["audio", "video", "dash"].includes(result.item?.kind)) {
      throw new Error(result?.error || "资源已失效，请在原网页重新扫描。");
    }
    media = result.item;
    credentialOrigin = result.credentialOrigin;
    el.title.textContent = media.name;
    el.site.textContent = new URL(media.url).host;
    el.start.disabled = false;
    status("选择保存位置即可开始下载。");
  } catch (error) {
    el.title.textContent = "无法打开资源";
    status(error.message || "请回到原网页重新扫描。", true);
  }
}

initialize();
