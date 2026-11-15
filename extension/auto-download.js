const check = signal => signal?.throwIfAborted();
export function validatePair(videoInfo, audioInfo) {
  const only = (info, kind) => info.tracks.length === 1 && info.tracks[0].kind === kind;
  if (!only(videoInfo, 'video') || !only(audioInfo, 'audio')) {
    throw new Error('未找到对应的独立画面和音轨，请在原网页播放目标视频后重新扫描。');
  }
  const duration = info => info.tracks[0].duration || info.duration;
  const videoDuration = duration(videoInfo), audioDuration = duration(audioInfo);
  if (!(videoDuration > 0) || !(audioDuration > 0)) throw new Error('无法确认音画时长，请在原网页重新播放后扫描。');
  if (Math.abs(videoDuration - audioDuration) > Math.max(2, Math.min(5, videoDuration * 0.01))) {
    throw new Error('音画时长不一致，请在原网页播放目标视频后重新扫描。');
  }
}

/** Download and inspect the actual video before deciding whether audio is needed.
 * Pairing is delegated to the trusted background; no candidate guessing occurs here.
 */
export async function automaticVideo({videoId, receive, inspect, pair, merge, signal, onStage = () => {}}) {
  check(signal);
  onStage('video'); const video = await receive(videoId, '正在下载视频', signal); check(signal);
  onStage('inspect'); const videoInfo = await inspect(video, {signal}); check(signal);
  const hasVideo = videoInfo.tracks.some(track => track.kind === 'video');
  const hasAudio = videoInfo.tracks.some(track => track.kind === 'audio');
  if (hasVideo && hasAudio) return {file: video, merged: false};
  if (videoInfo.tracks.length !== 1 || !hasVideo) throw new Error('该资源不是完整视频，请在原网页播放目标视频后重新扫描。');
  onStage('pair'); const association = await pair(videoId); check(signal);
  if (!association?.ok || !association.audioId || association.audioId === videoId) {
    throw new Error(association?.error || '尚未发现可可靠关联的音轨，请在原网页播放目标视频后重新扫描。');
  }
  onStage('audio'); const audio = await receive(association.audioId, '正在下载对应声音', signal); check(signal);
  const audioInfo = await inspect(audio, {signal}); check(signal);
  validatePair(videoInfo, audioInfo);
  onStage('merge'); const file = await merge(video, audio, {signal}); check(signal);
  return {file, merged: true};
}
