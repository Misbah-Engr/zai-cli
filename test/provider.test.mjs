import test from 'node:test';
import assert from 'node:assert/strict';
import {complete, endpointURL, sseEvents} from '../src/provider.mjs';
const encoder = new TextEncoder();
const stream = text => new ReadableStream({start(c) {for (let i=0;i<text.length;i+=7) c.enqueue(encoder.encode(text.slice(i,i+7))); c.close();}});
const frame = delta => `data: ${JSON.stringify({choices:[{delta}]})}\r\n\r\n`;
const ending = 'data: {"choices":[{"finish_reason":"stop","delta":{}}]}\r\n\r\ndata: [DONE]\r\n\r\n';
const call = (body, extra={}) => complete({apiKey:'test-secret',baseURL:'https://api.z.ai/api/paas/v4',model:'glm-4.7',messages:[],tools:[],fetchImpl:async()=>new Response(stream(body),{headers:{'content-type':'text/event-stream'}}),...extra});
test('stream parser handles chunk boundaries and CRLF', async()=>{
 let text=''; const result=await call(frame({content:'hello'})+ending,{onText:x=>text+=x}); assert.equal(text,'hello'); assert.equal(result.message.content,'hello');
});
test('streamed tool argument fragments are assembled',async()=>{
 const body=frame({tool_calls:[{index:0,id:'call1',function:{name:'read_file',arguments:'{"path":'}}]})+frame({tool_calls:[{index:0,function:{arguments:'"a"}'}}]})+ending;
 assert.deepEqual(JSON.parse((await call(body)).message.tool_calls[0].function.arguments),{path:'a'});
});
test('interrupted streams fail closed',async()=>{await assert.rejects(call(frame({content:'partial'})),/interrupted/);});
test('malformed stream fails closed',async()=>{await assert.rejects(call('data: {bad}\n\n'),/malformed/);});
test('endpoint rejects unsafe URLs and credentials',()=>{
 for(const url of ['http://example.com','https://user:pass@example.com','https://example.com/?key=secret']) assert.throws(()=>endpointURL(url));
 assert.equal(endpointURL('http://127.0.0.1:4000/v1').pathname,'/v1/chat/completions');
});
test('HTTP errors do not expose provider body',async()=>{
 await assert.rejects(call('',{fetchImpl:async()=>new Response('secret',{status:401})}),/HTTP 401/);
});
test('SSE parser rejects incomplete frames',async()=>{
 await assert.rejects(async()=>{for await(const _ of sseEvents(stream('data: hi'))){}},/incomplete/);
});
