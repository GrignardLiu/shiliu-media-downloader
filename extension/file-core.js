import {httpFailure} from "./media-request.js";

// A full file may arrive as HTTP 206 even when we didn't request a range.
// Only commit it if the response covers the entire representation.
export async function streamFile(response, writable, kind, onBytes, signal) {
  const reject = message => {
    response.body?.cancel().catch(() => {});
    throw new Error(message);
  };
  if (!response.ok || !response.body) {
    reject(httpFailure(response.status));
  }
  const mime = (response.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
  if (/html|json|javascript/.test(mime) || /^(image|font)\//.test(mime) ||
      (kind !== "dash" && /mpegurl|dash\+xml/.test(mime))) {
    reject("服务器返回的内容与所选文件类型不符，请回原网页重新播放并扫描。");
  }
  const encoded = !["", "identity"].includes((response.headers.get("Content-Encoding") || "").toLowerCase());
  let expected;
  if (response.status === 206 || response.headers.has("Content-Range")) {
    const match = /^bytes 0-(\d+)\/(\d+)$/i.exec(response.headers.get("Content-Range") || "");
    if (encoded || response.status !== 206 || !match || !Number.isSafeInteger(Number(match[2])) ||
        Number(match[1]) + 1 !== Number(match[2])) {
      reject("服务器只返回了部分文件，无法完整保存。");
    }
    expected = Number(match[2]);
  } else if (!encoded && response.headers.has("Content-Length")) {
    const length = response.headers.get("Content-Length");
    if (/^\d+$/.test(length) && Number.isSafeInteger(Number(length))) expected = Number(length);
  }

  let size = 0;
  const progress = new TransformStream({
    transform(chunk, output) {
      size += chunk.byteLength;
      if (size > expected) throw new Error("文件超出了服务器声明的长度，请重新下载。");
      output.enqueue(chunk);
      onBytes(size, expected);
    },
    flush() {
      if (!size || (expected !== undefined && size !== expected)) throw new Error("文件不完整，请重新下载。");
    },
  });
  await response.body.pipeThrough(progress).pipeTo(writable, {signal, preventClose: true, preventAbort: true});
}
