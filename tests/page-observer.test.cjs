const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const parserCode=readFileSync(path.join(__dirname,'../extension/page-media.js'),'utf8');
const observerCode=readFileSync(path.join(__dirname,'../extension/page-observer.js'),'utf8');
const api='https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=123456';
const page='https://www.douyin.com/video/123456';
function clip(id='123456',suffix='') {return {aweme_id:id,video:{play_addr:{url_list:['https://cdn.test/v'+suffix+'.mp4']},bit_rate_audio:[{audio_meta:{media_type:'audio',codec_type:'aac',file_id:'audio-'+id,url_list:{main_url:'https://cdn.test/a'+suffix+'.m4a'}}}]},secret:'do-not-publish',Cookie:'do-not-publish'};}
function response(value,options={}) {return new Response(typeof value==='string'?value:JSON.stringify(value),{headers:{'Content-Type':'application/json',...options.headers},...options});}
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
async function settled(){for(let index=0;index<16;index++)await new Promise(resolve=>setImmediate(resolve));}
function setup(fetcher=async()=>response(clip()),href=page){
 const nodes=[];const location=new URL(href);const events=new Map();
 const parent={appendChild(node){nodes.push(node);node.isConnected=true;return node;}};
 const document={head:parent,documentElement:parent,getElementById:id=>nodes.find(node=>node.id===id&&node.isConnected)||null,createElement:tag=>({tagName:tag.toUpperCase(),textContent:'',type:'',id:'',isConnected:false})};
 const history={pushState(state,title,url){if(this!==history)throw new Error('wrong history receiver');if(url!==undefined&&url!==null)location.href=new URL(url,location.href).href;return 'history-result';},replaceState(state,title,url){if(url!==undefined&&url!==null)location.href=new URL(url,location.href).href;return 'replace-result';}};
 class XHR {
  constructor(){this.events=new Map();this.status=0;this.responseURL='';this.responseType='';this.headers={};}
  open(){this.openArgs=[...arguments];return 'open-result';}
  send(){this.sendArgs=[...arguments];if(this.sendError)throw this.sendError;return 'send-result';}
  addEventListener(type,handler,options){const list=this.events.get(type)||[];list.push({handler,once:options?.once});this.events.set(type,list);}
  removeEventListener(type,handler){this.events.set(type,(this.events.get(type)||[]).filter(event=>event.handler!==handler));}
  getResponseHeader(name){return this.headers[name.toLowerCase()]??null;}
  complete(value,{json=false,url=api,type='application/json',status=200,length}={}){this.status=status;this.responseURL=url;this.headers={'content-type':type,'content-length':length??null};this.responseType=json?'json':'';this.response=json?value:null;this.responseText=json?'':typeof value==='string'?value:JSON.stringify(value);for(const event of [...(this.events.get('loadend')||[])]){if(event.once)this.events.set('loadend',this.events.get('loadend').filter(item=>item!==event));event.handler.call(this,{type:'loadend',target:this});}}
 }
 const context={URL,Request,Response,ReadableStream,TextDecoder,Promise,Reflect,Date,setTimeout,clearTimeout,atob,location,document,history,XMLHttpRequest:XHR,
  fetch:fetcher,addEventListener(type,listener){events.set(type,listener);}};
 vm.createContext(context);vm.runInContext(parserCode,context);vm.runInContext(observerCode,context);
 const bridge=()=>{const node=document.getElementById('shiliu-observed-media');return node?JSON.parse(node.textContent):null;};
 return {context,document,history,location,bridge,nodes,XHR,events};
}

test('fetch preserves request arguments, receiver, Response identity/body and rejection while observing only actual JSON',async()=>{
 const original=response({aweme_detail:clip()}),calls=[];const fixture=setup(function(){calls.push({receiver:this,args:[...arguments]});return Promise.resolve(original);});
 const options={credentials:'include',headers:{Authorization:'private'}};
 const actual=await fixture.context.fetch.call(fixture.context,api,options);assert.equal(actual,original);assert.equal(calls[0].receiver,fixture.context);assert.equal(calls[0].args[0],api);assert.equal(calls[0].args[1],options);
 assert.deepEqual(await actual.json(),{aweme_detail:clip()});await settled();
 const metadata=fixture.bridge();assert.equal(metadata.candidates.length,2);assert.equal(metadata.pageUrl,page);assert.ok(metadata.candidates.every(row=>row.observedAt<=metadata.observedAt));
 assert.equal(JSON.stringify(metadata).includes('do-not-publish'),false);assert.equal(JSON.stringify(metadata).includes('Authorization'),false);
 const failure=new TypeError('fetch failed');const broken=setup(()=>Promise.reject(failure));await assert.rejects(broken.context.fetch(api),error=>error===failure);
});

test('no extra fetches, API/domain/type restrictions, and oversized body leave original response untouched',async()=>{
 let calls=0;const fixture=setup(async()=>{calls++;return response(clip());});
 for(const url of ['https://evil.test/aweme/v1/web/aweme/detail/','https://www.douyin.com/aweme/v1/web/im/private/','https://www.douyin.com/favicon.ico'])await fixture.context.fetch(url);
 await settled();assert.equal(calls,3);assert.equal(fixture.bridge(),null);
 let cloneCalls=0;const huge=response(clip(),{headers:{'Content-Type':'application/json','Content-Length':String(3*1024**2)}});const clone=huge.clone.bind(huge);huge.clone=()=>{cloneCalls++;return clone();};
 const rejected=setup(async()=>huge);assert.equal(await rejected.context.fetch(api),huge);await settled();assert.equal(cloneCalls,0);assert.equal(rejected.bridge(),null);
 const oversized=response(JSON.stringify({padding:'x'.repeat(2*1024**2),aweme_detail:clip()}));const large=setup(async()=>oversized);const untouched=await large.context.fetch(api);assert.ok((await untouched.text()).length>2*1024**2);await settled();assert.equal(large.bridge(),null);
 const html=setup(async()=>new Response(JSON.stringify(clip()),{headers:{'Content-Type':'text/html'}}));await html.context.fetch(api);await settled();assert.equal(html.bridge(),null);
});

test('generation rejects delayed A response after A -> B -> A and clears prior cache',async()=>{
 const delayed=deferred();let request=0;const fixture=setup(()=>++request===1?delayed.promise:Promise.resolve(response(clip())));
 const pending=fixture.context.fetch(api);assert.equal(fixture.history.pushState({},'', '/video/654321'),'history-result');assert.equal(fixture.history.replaceState({},'', '/video/123456'),'replace-result');
 delayed.resolve(response(clip()));await pending;await settled();assert.equal(fixture.bridge().candidates.length,0);
 await fixture.context.fetch(api);await settled();assert.equal(fixture.bridge().candidates.length,2);
 fixture.history.pushState({},'', '/video/777777');assert.equal(fixture.bridge().candidates.length,0);assert.equal(fixture.bridge().pageUrl,'https://www.douyin.com/video/777777');
});

test('XHR wrappers preserve open/send/results/events and only publish parsed metadata',()=>{
 const fixture=setup();const xhr=new fixture.XHR(),events=[];
 assert.equal(xhr.open('GET',api,false,'user','password'),'open-result');assert.deepEqual(xhr.openArgs,['GET',api,false,'user','password']);
 xhr.addEventListener('loadend',event=>events.push(event.target));assert.equal(xhr.send('body'),'send-result');assert.deepEqual(xhr.sendArgs,['body']);
 xhr.complete({aweme_detail:clip()},{json:true});assert.equal(events[0],xhr);assert.equal(fixture.bridge().candidates.length,2);
 assert.equal(fixture.bridge().candidates.some(row=>row.url.includes('password')),false);
 const failure=new Error('send failed'),bad=new fixture.XHR();bad.open('GET',api);bad.sendError=failure;assert.throws(()=>bad.send(),error=>error===failure);assert.equal(bad.events.get('loadend').length,0);
 const large=new fixture.XHR();large.open('GET',api);large.send();large.complete(JSON.stringify({padding:'中'.repeat(750000),aweme_detail:clip('654321','2')}));assert.equal(fixture.bridge().candidates.length,2);
});

test('overlapping fetch observation is bounded to two; same-URL cross-owner conflicts fail closed',async()=>{
 const controllers=[];let calls=0;
 const fixture=setup(()=>{calls++;if(calls<=2)return Promise.resolve(new Response(new ReadableStream({start(controller){controllers.push(controller);}}),{headers:{'Content-Type':'application/json'}}));return Promise.resolve(response(clip('777777','third')));});
 const first=await fixture.context.fetch(api),second=await fixture.context.fetch(api);await fixture.context.fetch(api);await settled();assert.equal(fixture.bridge(),null);
 controllers.forEach((controller,index)=>{controller.enqueue(new TextEncoder().encode(JSON.stringify(clip(index?'654321':'123456',String(index)))));controller.close();});
 await Promise.all([first.text(),second.text()]);await settled();assert.equal(fixture.bridge().candidates.length,4);assert.equal(fixture.bridge().candidates.some(row=>row.awemeId==='777777'),false);
 let count=0;const conflict=setup(async()=>response(clip(++count===1?'123456':'654321')));
 await conflict.context.fetch(api);await settled();assert.equal(conflict.bridge().candidates.length,2);
 await conflict.context.fetch(api);await settled();assert.equal(conflict.bridge().candidates.length,0);
});


test('DOM publication failure never changes original fetch/history results',async()=>{
 const fixture=setup();const original=fixture.document.head.appendChild;
 fixture.document.head.appendChild=()=>{throw new Error('page DOM unavailable');};
 assert.equal(fixture.history.pushState({},'', '/video/654321'),'history-result');
 const result=await fixture.context.fetch(api);assert.equal(result.status,200);await result.text();await settled();
 fixture.document.head.appendChild=original;
});

test('observer bridge/cache stays small and single-node across many distinct signed URLs',async()=>{
 let sequence=0;const fixture=setup(async()=>{
  const id=String(123456+sequence++),value=clip(id,id);
  value.video.play_addr.url_list=Array.from({length:32},(_,index)=>'https://cdn.test/video-'+id+'-'+index+'.mp4?sign='+('x'.repeat(4000)));
  return response(value);
 });
 for(let index=0;index<4;index++){await fixture.context.fetch(api);await settled();}
 const node=fixture.document.getElementById('shiliu-observed-media');
 assert.ok(node.textContent.length<=256*1024);assert.ok(fixture.bridge().candidates.length<=400);
 assert.equal(fixture.nodes.length,1);assert.equal(node.type,'application/json');
 assert.equal(fixture.bridge().candidates.some(row=>row.awemeId==='123456'),false);
 assert.ok(fixture.bridge().candidates.some(row=>row.awemeId==='123459'));
});
