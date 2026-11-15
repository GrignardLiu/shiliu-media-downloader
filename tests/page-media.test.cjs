const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = {URL, atob};
vm.runInNewContext(readFileSync(path.join(__dirname, '../extension/page-media.js'), 'utf8'), context);
const {extract, extractJson, LIMITS} = context.ShiliuPageMedia;
const pageUrl = 'https://www.douyin.com/video/7433333333333333333';
const json = value => JSON.parse(JSON.stringify(value));
const videoUrl = 'https://v3.douyinvod.com/opaque-video?sig=exact%2Ftoken&mime_type=video_mp4';
const audioUrl = 'https://v9.douyinvod.com/opaque-audio?sig=other%2fToken&mime_type=audio_mp4';
const backupUrl = 'https://v26.douyinvod.com/opaque-backup?mime_type=audio_mp4&sig=backup';
function clip(id = '7433333333333333333', v = videoUrl, a = audioUrl) {
  return {aweme_id:id, desc:'video title', video:{play_addr:{uri:'video0001',url_list:[v]},
    bit_rate:[{bit_rate:2400000,gear_name:'1080p',play_addr:{url_list:[v]}}],
    bit_rate_audio:[{audio_meta:{file_id:'audio-file-01',media_type:'audio',codec_type:'aac',format:'mp4',bitrate:128000,url_list:{main_url:a,backup_url:backupUrl}}}]},
    music:{play_url:{url_list:['https://music.douyinstatic.com/background.mp3']}}};
}

test('snake-case API metadata associates only literal per-clip URLs and groups audio backups', () => {
  const rows = json(extractJson({aweme_detail:clip()},{pageUrl}));
  assert.equal(rows.length,3);
  assert.deepEqual(rows.map(row=>row.kind),['video','audio','audio']);
  assert.equal(rows[0].url,videoUrl); assert.equal(rows[1].url,audioUrl); assert.equal(rows[2].url,backupUrl);
  assert.equal(rows[0].bitrate,2400000); assert.equal(rows[1].bitrate,128000); assert.equal(rows[1].codec,'aac');
  assert.equal(rows[1].audioGroup,rows[2].audioGroup); assert.equal(rows[1].trackId,'audio-file-01');
  assert.equal(rows.every(row=>row.awemeId==='7433333333333333333' && row.pairId==='dy-aweme-7433333333333333333'),true);
  assert.equal(rows.some(row=>row.url.includes('background')),false);
});

test('RENDER_DATA and camel-case videoDetail preserve independent clip identities, not current page ID', () => {
  const camel = {awemeId:'7444444444444444444',video:{playAddr:[{src:'https://cdn.test/v-two.mp4?signature=abc%2F'}],
    bitRateAudioList:[{audioMeta:{fileId:'audio-two',codecType:'aac',bitrate:96000,urlList:{mainUrl:'https://cdn.test/a-two.m4a'}}}]}};
  const payload = {currentVideoId:'7433333333333333333',detail:{videoDetail:camel},recommendations:[clip()]};
  const rows = json(extract({pageUrl,scripts:[{id:'RENDER_DATA',text:encodeURIComponent(JSON.stringify(payload))}]}));
  assert.equal(rows.length,5);
  assert.equal(rows.find(row=>row.url.includes('v-two')).awemeId,'7444444444444444444');
  assert.equal(rows.find(row=>row.url===videoUrl).awemeId,'7433333333333333333');
  assert.equal(rows.find(row=>row.url.includes('a-two')).audioGroup.startsWith('dy-audio-7444444444444444444'),true);
});

test('React pace Flight JSON chunks parse without executing page JavaScript', () => {
  const payload = 'a:' + JSON.stringify({videoDetail:clip()}) + '\n';
  const code = 'globalThis.__mustNotRun = true; self.__pace_f.push(' + JSON.stringify([1,payload]) + ');';
  const rows = json(extract({pageUrl,scripts:[{text:code}]}));
  assert.equal(rows.length,3); assert.equal(context.__mustNotRun,undefined);
  assert.equal(extract({pageUrl,scripts:[{text:'globalThis.__mustNotRun = true;'}]}).length,0);
});

test('music-only, sibling video/audio, generic IDs and unsafe/contradictory IDs never prove a pair', () => {
  const musicOnly=clip();delete musicOnly.video.bit_rate_audio;
  assert.deepEqual(json(extractJson(musicOnly,{pageUrl})).map(row=>row.kind),['video']);
  const unrelated={aweme_id:'123456',video:{play_addr:{url_list:[videoUrl]}}};
  const audioSibling={aweme_id:'654321',video:{bit_rate_audio:clip().video.bit_rate_audio}};
  const rows=json(extractJson([unrelated,audioSibling],{pageUrl}));
  assert.equal(rows.find(row=>row.kind==='video').contentId,'123456');assert.equal(rows.find(row=>row.kind==='audio').contentId,'654321');
  for(const bad of [{id:'7433333333333333333',video:clip().video},{aweme_id:7433333333333333333,video:clip().video},{aweme_id:'123456',awemeId:'654321',video:clip().video}]) assert.equal(extractJson(bad,{pageUrl}).length,0);
  for(const badPage of ['https://not-douyin.test/video/123','https://douyin.com.evil.test/','https://douyinvod.com/','file:///tmp/page']) assert.equal(extractJson(clip(),{pageUrl:badPage}).length,0);
});

test('unsafe URLs, role mismatch and shared URL under conflicting clip IDs fail closed', () => {
  for(const bad of ['javascript:alert(1)','data:video/mp4,bad','https://u:p@cdn.test/v.mp4','not-a-url','https://cdn.test/cover.jpg']) {
    const value=clip('123456',bad,bad);value.video.bit_rate=[];value.video.bit_rate_audio[0].audio_meta.url_list={main_url:bad};
    assert.equal(extractJson(value,{pageUrl}).length,0,bad);
  }
  const same=clip('123456',audioUrl,videoUrl);same.video.bit_rate=[];same.video.bit_rate_audio[0].audio_meta.url_list={main_url:videoUrl};
  assert.equal(extractJson(same,{pageUrl}).length,0);
  const conflicts=json(extractJson([clip('123456'),clip('654321')],{pageUrl}));assert.equal(conflicts.length,0);
});

test('encoded URL fields and duplicate scripts retain signatures and deterministic backup order', () => {
  const value=clip();value.video.bit_rate_audio[0].audio_meta.url_list.main_url=Buffer.from(audioUrl).toString('base64');
  const source=JSON.stringify(value);
  const rows=json(extract({pageUrl,scripts:[{type:'application/json',text:source},{id:'RENDER_DATA',text:encodeURIComponent(source)}]}));
  assert.deepEqual(rows.filter(row=>row.kind==='audio').map(row=>row.url),[audioUrl,backupUrl]);
});

test('bounded inputs reject complexity and do not invoke object getters', () => {
  const value=clip();Object.defineProperty(value,'privateGetter',{enumerable:true,get(){throw new Error('must not read');}});
  assert.equal(extractJson(value,{pageUrl}).length,3);
  const deep={};let next=deep;for(let index=0;index<LIMITS.depth+1;index++){next.child={};next=next.child;}Object.assign(next,clip());
  assert.equal(extractJson(deep,{pageUrl}).length,0);
  assert.equal(extractJson(Array(LIMITS.nodes+1).fill(null),{pageUrl}).length,0);
  assert.equal(extract({pageUrl,scripts:[{id:'RENDER_DATA',text:' '.repeat(LIMITS.scriptChars+1)+JSON.stringify(clip())}]}).length,0);
  const cyclic=clip();cyclic.self=cyclic;assert.equal(extractJson(cyclic,{pageUrl}).length,3);
});

