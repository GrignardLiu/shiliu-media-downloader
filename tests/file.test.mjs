import assert from "node:assert/strict";
import {test} from "node:test";
import {streamFile} from "../extension/file-core.js";

async function receive(response, kind = "video") {
  const chunks = [];
  const progress = [];
  const output = new WritableStream({write: chunk => chunks.push(Buffer.from(chunk))});
  await streamFile(response, output, kind, (bytes, total) => progress.push([bytes, total]),
    new AbortController().signal);
  return {bytes: Buffer.concat(chunks), progress};
}

test("direct stream accepts full-file 206 and writes bytes without retaining the full response", async () => {
  const stream = new ReadableStream({start(source) {
    source.enqueue(new Uint8Array([1, 2]));
    source.enqueue(new Uint8Array([3]));
    source.close();
  }});
  const result = await receive(new Response(stream, {status: 206, headers: {"content-range": "bytes 0-2/3"}}));
  assert.deepEqual([...result.bytes], [1, 2, 3]);
  assert.deepEqual(result.progress, [[2, 3], [3, 3]]);
});

test("direct stream rejects incomplete ranges, truncated files and server error pages", async () => {
  await assert.rejects(receive(new Response("xy", {status: 206, headers: {"content-range": "bytes 0-1/3"}})), /部分/);
  await assert.rejects(receive(new Response("xy", {headers: {"content-length": "4"}})), /不完整/);
  await assert.rejects(receive(new Response("expired", {status: 412})), /HTTP 412/);
  await assert.rejects(receive(new Response("<html>sign in", {headers: {"content-type": "text\/html"}})), /类型不符/);
});

test("encoded content does not compare decoded bytes to the transport length", async () => {
  const result = await receive(new Response("decoded", {headers: {"content-length": "2", "content-encoding": "gzip"}}));
  assert.equal(result.bytes.toString(), "decoded");
  assert.equal(result.progress.at(-1)[1], undefined);
});
