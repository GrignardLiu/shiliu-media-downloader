import assert from "node:assert/strict";
import {test} from "node:test";
import {readFile,writeFile,mkdir,mkdtemp} from "node:fs/promises";
import {resolve,join} from "node:path";
import {spawnSync} from "node:child_process";
import {mergeMp4,inspectMp4} from "../extension/mp4-merge.js";
const available = spawnSync("ffmpeg",["-version"]).status === 0 && spawnSync("ffprobe",["-version"]).status === 0;
function run(cmd,args) {const r=spawnSync(cmd,args,{encoding:"utf8"}); assert.equal(r.status,0,r.stderr||r.error?.message);return r.stdout;}
test("malformed, truncated, fragmented and cancelled input",async()=>{
 await assert.rejects(mergeMp4(new Blob(["bad"]),new Blob()),/完整/);
 await assert.rejects(mergeMp4(new Blob([Buffer.from([0,0,0,90,109,111,111,118])]),new Blob()),/截断/);
 await assert.rejects(mergeMp4(new Blob([Buffer.from([0,0,0,8,109,111,111,102])]),new Blob()),/完整/);
 const c=new AbortController();c.abort();await assert.rejects(mergeMp4(new Blob(),new Blob(),{signal:c.signal}),{name:"AbortError"});
});
test("real MP4 retains packets and edit timing, decodes, rejects bad offsets/encryption",{skip:!available},async()=>{
 await mkdir(resolve("work"),{recursive:true});const dir=await mkdtemp(join(resolve("work"),"mp4-test-"));
 const v=join(dir,"v.mp4"),a=join(dir,"a.mp4"),o=join(dir,"out.mp4");
 run("ffmpeg",["-v","error","-f","lavfi","-i","testsrc=size=64x64:rate=10:duration=1.2","-an","-c:v","libx264","-pix_fmt","yuv420p","-y",v]);
 run("ffmpeg",["-v","error","-f","lavfi","-i","sine=frequency=440:duration=1.2","-vn","-c:a","aac","-movie_timescale","90000","-y",a]);
 const vb=new Blob([await readFile(v)]),ab=new Blob([await readFile(a)]);
 assert.deepEqual((await inspectMp4(vb)).tracks.map(t=>t.kind),["video"]);assert.deepEqual((await inspectMp4(ab)).tracks.map(t=>t.kind),["audio"]);
 const result=await mergeMp4(vb,ab);await writeFile(o,new Uint8Array(await result.arrayBuffer()));
 const info=JSON.parse(run("ffprobe",["-v","error","-show_streams","-show_format","-of","json",o]));
 assert.deepEqual(info.streams.map(s=>s.codec_type),["video","audio"]);assert.ok(Math.abs(Number(info.format.duration)-1.2)<0.05);
 run("ffmpeg",["-v","error","-i",o,"-f","null","-"]);
 const packets=p=>JSON.parse(run("ffprobe",["-v","error","-show_packets","-show_data_hash","sha256","-of","json",p])).packets;
 const output=packets(o);
 for(const [index,path] of [v,a].entries()) {const input=packets(path),merged=output.filter(p=>p.stream_index===index);assert.deepEqual(merged.map(p=>p.data_hash),input.map(p=>p.data_hash));assert.deepEqual(merged.map(p=>p.pts_time),input.map(p=>p.pts_time));}
 await assert.rejects(mergeMp4(ab,vb),/视频/);
 const c=new AbortController();await assert.rejects(mergeMp4(vb,ab,{signal:c.signal,onProgress:p=>{if(p.stage==="index")c.abort();}}),{name:"AbortError"});
 const bad=Buffer.from(await vb.arrayBuffer()),at=bad.indexOf(Buffer.from("stco"));assert.ok(at>0);bad.writeUInt32BE(0xffffffff,at+12);await assert.rejects(mergeMp4(new Blob([bad]),ab),/偏移/);
 const enc=Buffer.from(await ab.arrayBuffer()),entry=enc.indexOf(Buffer.from("mp4a"));assert.ok(entry>0);enc.write("enca",entry);await assert.rejects(mergeMp4(vb,new Blob([enc])),/加密/);
 const f=join(dir,"frag.mp4");run("ffmpeg",["-v","error","-i",v,"-c","copy","-movflags","frag_keyframe+empty_moov","-y",f]);const fv=new Blob([await readFile(f)]); assert.equal((await inspectMp4(fv)).fragmented,true);assert.ok((await inspectMp4(fv)).tracks[0].duration > 1);
 const fa=join(dir,"frag-a.mp4");run("ffmpeg",["-v","error","-i",a,"-c","copy","-movflags","frag_keyframe+empty_moov+default_base_moof","-y",fa]);
 for(const [index,pair] of [[fv,ab],[vb,new Blob([await readFile(fa)])],[fv,new Blob([await readFile(fa)])]].entries()) {
  const dest=join(dir,`fragment-${index}.mp4`);await writeFile(dest,new Uint8Array(await (await mergeMp4(...pair)).arrayBuffer()));run("ffmpeg",["-v","error","-i",dest,"-f","null","-"]);
  const ps=packets(dest);
  for (const [trackIndex,inputPath] of (index === 0 ? [f,a] : index === 1 ? [v,fa] : [f,fa]).entries()) {
   const expected=packets(inputPath),actual=ps.filter(p=>p.stream_index===trackIndex);
   assert.deepEqual(actual.map(p=>[p.pts_time,p.dts_time,p.duration_time]),expected.map(p=>[p.pts_time,p.dts_time,p.duration_time]));
  }assert.deepEqual(ps.filter(p=>p.stream_index===0).map(p=>p.data_hash),packets(f).map(p=>p.data_hash));assert.equal(new Set(ps.map(p=>p.stream_index)).size,2);assert.deepEqual(ps.filter(p=>p.stream_index===1).map(p=>p.data_hash),packets(a).map(p=>p.data_hash));
 }
 // Unsafe fragment timing and sample ranges must fail before producing a file.
 const firstNonzero=Buffer.from(await readFile(f)),tfdt=firstNonzero.indexOf(Buffer.from("tfdt"));
 assert.ok(tfdt>0); const timeAt=tfdt+8;
 if(firstNonzero[tfdt+4]) firstNonzero.writeBigUInt64BE(1n,timeAt); else firstNonzero.writeUInt32BE(1,timeAt);
 await assert.rejects(mergeMp4(new Blob([firstNonzero]),ab),/间隙|起点/);
 const range=Buffer.from(await readFile(f)),runAt=range.indexOf(Buffer.from("trun"));
 const mask=range.readUInt32BE(runAt+4)&0xffffff;assert.ok(mask&512);
 let sampleAt=runAt+12+(mask&1?4:0)+(mask&4?4:0);
 range.writeUInt32BE(0xffffffff,sampleAt+(mask&256?4:0));
 await assert.rejects(mergeMp4(new Blob([range]),ab),/样本范围/);
 const description=Buffer.from(await readFile(f)),trex=description.indexOf(Buffer.from("trex"));
 assert.ok(trex>0);description.writeUInt32BE(2,trex+12);
 await assert.rejects(mergeMp4(new Blob([description]),ab),/描述索引/);
 const gaps=join(dir,"gap-source.mp4");run("ffmpeg",["-v","error","-i",v,"-c","copy","-movflags","frag_keyframe+empty_moov","-frag_duration","300000","-y",gaps]);
 const gap=Buffer.from(await readFile(gaps)),second=gap.indexOf(Buffer.from("tfdt"),gap.indexOf(Buffer.from("tfdt"))+4);
 assert.ok(second>0);if(gap[second+4])gap.writeBigUInt64BE(gap.readBigUInt64BE(second+8)+1n,second+8);else gap.writeUInt32BE(gap.readUInt32BE(second+8)+1,second+8);
 await assert.rejects(mergeMp4(new Blob([gap]),ab),/间隙|重叠/);
 const signed=join(dir,"signed-cto.mp4"),signedOut=join(dir,"signed-merged.mp4");
 run("ffmpeg",["-v","error","-i",v,"-c","copy","-movflags","frag_keyframe+empty_moov+negative_cts_offsets","-y",signed]);
 await assert.rejects(mergeMp4(new Blob([await readFile(signed)]),ab),/负组合时间偏移/);
 // Every fragment input now yields a conventional MP4 with no moof/mvex.
 for(const index of [0,1,2]) assert.equal((await inspectMp4(new Blob([await readFile(join(dir,`fragment-${index}.mp4`))]))).fragmented,false);

});



