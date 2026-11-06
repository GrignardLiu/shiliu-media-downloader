export async function fetchMedia(url, signal, credentialOrigin, headers = {}) {
  const request = {headers, signal, referrerPolicy: "no-referrer"};
  if (new URL(url).origin === credentialOrigin) {
    const response = await fetch(url, {...request, credentials: "include", redirect: "manual"});
    if (response.type !== "opaqueredirect" && ![301, 302, 303, 307, 308].includes(response.status)) return response;
    // A manual redirect hides Location. Follow from the start without cookies
    // so the redirect cannot involve another site's login state.
    await response.body?.cancel();
  }
  return fetch(url, {...request, credentials: "omit", redirect: "follow"});
}

export function httpFailure(status) {
  if (status === 401) return "HTTP 401。网站要求有效的登录状态。请在原网页确认能播放，再重新扫描。";
  if (status === 403) return "HTTP 403。网站拒绝了下载请求，或媒体链接已经过期。请在原网页重新播放并扫描。";
  if (status === 412) return "HTTP 412。服务器未接受下载请求的来源或其他条件。请刷新原网页并重新播放，再打开最新的资源。";
  return "服务器返回 HTTP " + status + "。请回原网页重新播放后再试。";
}
