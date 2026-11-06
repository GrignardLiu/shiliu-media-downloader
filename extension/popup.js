"use strict";

const byId = (id) => document.getElementById(id);
const list = byId("list");
const refreshButton = byId("refresh");
const filters = byId("filters");
const typeNames = { video: "视频", audio: "音频", stream: "流媒体" };
const feedback = new Map();
const downloads = new Map();
let tabId;
let items = [];
let hasBlob = false;
let scanBlocked = false;
let filter = "all";
let scanning = false;

function groupOf(item) {
  return item.kind === "hls" || item.kind === "dash" ? "stream" : item.kind;
}

function displayName(item) {
  // The full media URL may contain a signed query. Use only its pathname for a fallback.
  let name = item.name;
  if (!name) {
    try {
      const segment = new URL(item.url).pathname.split("/").pop();
      name = decodeURIComponent(segment);
    } catch { /* The media type also makes a readable fallback. */ }
  }
  return String(name || "").replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "").trim()
    || typeNames[groupOf(item)] + "资源";
}

function hasMasterName(item) {
  return item.kind === "hls" && /^master\.m3u8?$/i.test(displayName(item));
}

function formatOf(item) {
  if (item.kind === "hls") return "HLS";
  if (item.kind === "dash") return "DASH";
  const ext = String(item.extension || "").replace(/^\./, "");
  if (/^[a-z0-9]{1,10}$/i.test(ext)) return ext.toUpperCase();
  return typeNames[groupOf(item)];
}

function readableSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unit = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1000)));
  const amount = bytes / 1000 ** unit;
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: amount < 10 ? 1 : 0 }).format(amount) + " " + units[unit];
}

function descriptionOf(item) {
  let host = "";
  try { host = new URL(item.url).hostname; } catch { /* A media type is sufficient. */ }
  const detail = item.kind === "dash" ? "仅播放清单" : readableSize(item.size);
  return [detail || typeNames[groupOf(item)], host].filter(Boolean).join(" · ");
}

function setStatus(message, tone = "") {
  byId("status").textContent = message;
  byId("status").dataset.tone = tone;
}

function showFeedback(row, id) {
  const state = feedback.get(id);
  const note = row.querySelector(".transfer-status");
  note.textContent = state?.message || "";
  note.dataset.tone = state?.tone || "";
  note.hidden = !state;
  row.querySelector(".action").disabled = Boolean(state?.busy);
}

function setFeedback(id, message, tone = "", busy = false) {
  feedback.set(id, {message, tone, busy});
  for (const row of list.children) {
    if (row.dataset.item === id) showFeedback(row, id);
  }
  setStatus(message, tone);
}

function interruption(reason) {
  if (reason === "USER_CANCELED") return "已取消下载。";
  if (reason === "SERVER_FAILED") {
    const next = items.some(item => item.kind === "hls")
      ? "页面中也有 HLS 资源，可在「流媒体」中点「HLS 下载」。"
      : "请稍后重试，或在原网页重新播放后扫描。";
    return "服务器未能完成此次下载（SERVER_FAILED）。" + next;
  }
  if (["SERVER_FORBIDDEN", "SERVER_UNAUTHORIZED"].includes(reason)) {
    return "网站拒绝了下载请求。请在原网页重新播放，获取新的下载地址。";
  }
  if (reason === "FILE_NO_SPACE") return "磁盘空间不足。请释放空间后重试。";
  if (reason === "FILE_ACCESS_DENIED") return "浏览器无法写入下载目录，请检查保存位置。";
  if (reason?.startsWith("NETWORK_")) return "网络请求中断。请检查网络后再试。";
  return "下载已中断" + (reason ? "（" + reason + "）" : "") + "，可在浏览器下载记录中查看。";
}

async function updateDownload(downloadId) {
  const id = downloads.get(downloadId);
  if (!id) return;
  // A download may finish or fail before downloads.download() returns its ID.
  const [item] = await chrome.downloads.search({id: downloadId}).catch(() => []);
  if (!downloads.has(downloadId)) return;
  if (item?.state === "in_progress") {
    setFeedback(id, item.paused ? "浏览器已暂停，可在下载记录中继续。" : "正在下载，可在浏览器下载记录中查看进度。", "", true);
    return;
  }
  downloads.delete(downloadId);
  if (item?.state === "interrupted") {
    setFeedback(id, interruption(item.error), item.error === "USER_CANCELED" ? "" : "error");
  } else if (item?.state === "complete") {
    if (/^(?:text\/html|application\/(?:json|xhtml\+xml))\b/i.test(item.mime || "")) {
      setFeedback(id, "服务器返回了网页或接口数据。请回原网页重新播放，再扫描媒体地址。", "error");
    } else {
      setFeedback(id, "已下载，可在浏览器下载记录中打开。", "success");
    }
  } else {
    setFeedback(id, "已提交下载，请在浏览器下载记录中查看状态。");
  }
}

chrome.downloads.onChanged.addListener(change => {
  if (downloads.has(change.id) && (change.state || change.error || change.paused)) {
    updateDownload(change.id);
  }
});

function explainError(error, fallback) {
  const message = typeof error === "string" ? error : error?.message;
  if (message === "SERVER_FAILED") return interruption(message);
  // Browser-level exceptions can contain request URLs. Display our own localized fallback for those.
  return message && /[\u3400-\u9fff]/.test(message) && !/https?:/i.test(message)
    ? message.slice(0, 220) : fallback;
}

function emptyState(title, description, icon) {
  byId("empty-title").textContent = title;
  byId("empty-text").textContent = description;
  byId("empty-icon").setAttribute("href", "#i-" + icon);
  byId("empty").hidden = false;
  list.hidden = true;
}

function makeRow(item) {
  const row = byId("row-template").content.firstElementChild.cloneNode(true);
  const group = groupOf(item);
  const name = displayName(item);
  row.dataset.group = group;
  row.dataset.item = item.id;
  row.querySelector(".media-icon use").setAttribute("href", "#i-" + group);
  const title = row.querySelector(".media-title");
  title.textContent = name;
  title.title = name;
  const detail = descriptionOf(item);
  row.querySelector(".format").textContent = formatOf(item);
  row.querySelector(".detail").textContent = detail;
  row.querySelector(".detail").title = detail;

  const action = row.querySelector(".action");
  const isHls = item.kind === "hls";
  const label = isHls ? "HLS 下载" : item.kind === "dash" ? "保存清单" : "下载";
  const fullLabel = isHls ? "打开 HLS 下载页，有多档画质时可选择" : item.kind === "dash" ? "保存 DASH 播放清单" : "下载文件";
  action.querySelector("use").setAttribute("href", isHls ? "#i-open" : "#i-download");
  action.querySelector("span").textContent = label;
  action.setAttribute("aria-label", fullLabel + "，" + name);
  action.title = fullLabel;
  const sourceTab = tabId;
  action.addEventListener("click", () => runAction(item, sourceTab));
  showFeedback(row, item.id);
  return row;
}

function render() {
  byId("count").textContent = items.length + " 项";
  for (const button of filters.querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.filter === filter));
  }
  byId("blob-note").hidden = !hasBlob || !items.length || items.some(item => item.kind === "hls");
  const visible = items.filter((item) => filter === "all" || groupOf(item) === filter);
  list.replaceChildren(...visible.map(makeRow));
  if (visible.length) {
    list.hidden = false;
    byId("empty").hidden = true;
  } else if (items.length) {
    emptyState("没有" + typeNames[filter] + "资源", "切换到“全部”可查看已发现的资源。", "search");
  } else if (scanBlocked) {
    emptyState("无法读取此页面", "请打开普通网页，并在浏览器的扩展菜单中允许拾流访问当前网站，再重新扫描。", "page");
  } else if (hasBlob) {
    emptyState("只发现了临时媒体地址", "请在页面上播放几秒，再重新扫描原始媒体或播放列表。", "stream");
  } else {
    emptyState("还没有发现媒体", "先播放页面里的视频或音频，再点“重新扫描”。刚安装扩展时，请先刷新网页。", "search");
  }
}

async function runAction(item, sourceTab) {
  if (feedback.get(item.id)?.busy) return;
  setFeedback(item.id, item.kind === "hls" ? "正在打开下载页…" : "正在准备下载…", "", true);
  try {
    if (item.kind === "hls") {
      const params = new URLSearchParams({ tab: String(sourceTab), item: item.id });
      await chrome.tabs.create({ url: chrome.runtime.getURL("hls.html") + "#" + params });
      setFeedback(item.id, "已打开 HLS 下载页，请在新页选择保存位置。", "success");
    } else {
      const result = await chrome.runtime.sendMessage({ type: "DOWNLOAD_MEDIA", tabId: sourceTab, id: item.id });
      if (!result?.ok) throw new Error(result?.error || "下载请求失败，请重新扫描后再试。");
      if (result.opened) {
        setFeedback(item.id, "已打开下载页，请在新页查看进度和保存位置。", "success");
      } else if (Number.isInteger(result.downloadId)) {
        downloads.set(result.downloadId, item.id);
        await updateDownload(result.downloadId);
      } else {
        throw new Error("浏览器未确认下载，请重新扫描后再试。");
      }
    }
  } catch (error) {
    setFeedback(item.id, explainError(error, "浏览器未能开始下载。请在原网页重新播放，再扫描新的地址。"), "error");
  }
}

async function scan() {
  if (scanning) return;
  scanning = true;
  setStatus("");
  refreshButton.disabled = true;
  refreshButton.setAttribute("aria-busy", "true");
  byId("results").setAttribute("aria-busy", "true");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!Number.isInteger(tab?.id)) throw new Error("请打开要下载媒体的网页，再试一次。");
    tabId = tab.id;
    const site = byId("site");
    if (tab.url) {
      const address = new URL(tab.url);
      if (!["http:", "https:"].includes(address.protocol)) {
        site.textContent = "页面影音下载器";
        site.removeAttribute("title");
        filters.hidden = true;
        byId("count").textContent = "";
        byId("blob-note").hidden = true;
        emptyState("请打开普通网页", "在 HTTP 或 HTTPS 网页上播放视频或音频，然后打开拾流。", "page");
        return;
      }
      site.textContent = address.hostname;
      site.title = address.hostname;
    }
    const result = await chrome.runtime.sendMessage({ type: "LIST_MEDIA", tabId });
    if (!result?.ok) throw new Error(result?.error || "请刷新当前网页，再重新扫描。");
    // A conventional master filename is a sorting hint. Only the HLS page parses the actual playlist.
    items = Array.isArray(result.items)
      ? result.items.slice().sort((a, b) => Number(hasMasterName(b)) - Number(hasMasterName(a))) : [];
    hasBlob = Boolean(result.hasBlob);
    scanBlocked = Boolean(result.scanBlocked);
    filters.hidden = false;
    render();
  } catch (error) {
    filters.hidden = true;
    byId("blob-note").hidden = true;
    byId("count").textContent = "";
    emptyState("扫描未完成", explainError(error, "请刷新当前网页，再重新扫描。"), "refresh");
  } finally {
    scanning = false;
    refreshButton.disabled = false;
    refreshButton.removeAttribute("aria-busy");
    byId("results").setAttribute("aria-busy", "false");
  }
}

filters.addEventListener("click", (event) => {
  const selected = event.target.closest("button[data-filter]");
  if (!selected || filter === selected.dataset.filter) return;
  filter = selected.dataset.filter;
  render();
});
refreshButton.addEventListener("click", scan);
scan();
