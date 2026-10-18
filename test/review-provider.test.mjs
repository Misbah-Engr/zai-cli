import test from 'node:test';
import assert from 'node:assert/strict';
import {complete} from '../src/provider.mjs';
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const delta = value => frame({choices:[{delta:value}]});
const end = reason => frame({choices:[{delta:{},finish_reason:reason}]}) + 'data: [DONE]\n\n';
function request(body, extra={}) {
 const bytes = new TextEncoder().encode(body);
 const stream = new ReadableStream({start(c) { for(let i=0;i<bytes.length;i++) c.enqueue(bytes.slice(i,i+1)); c.close(); }});
 return complete({apiKey:'fake',baseURL:'https://api.z.ai/api/coding/paas/v4',model:'test',messages:[],tools:[],fetchImpl:async()=>new Response(stream,{headers:{'content-type':'text/event-stream'}}),...extra});
}
test('review: UTF-8 survives byte-at-a-time transport', async()=> {
 let seen=''; const value='naïve 中文 👩🏽‍💻';
 const result=await request(delta({content:value})+end('stop'),{onText:t=>seen+=t});
 assert.equal(seen,value); assert.equal(result.message.content,value);
});
test('review: interleaved tool fragments retain independent arguments',async()=>{
 const body=delta({tool_calls:[{index:1,id:'b',function:{name:'read_file',arguments:'{"path":"b'}},{index:0,id:'a',function:{name:'read_file',arguments:'{"path":"a'}}]})+delta({tool_calls:[{index:0,function:{arguments:'"}'}},{index:1,function:{arguments:'"}'}}]})+end('tool_calls');
 const result=await request(body); assert.deepEqual(result.message.tool_calls.map(c=>[c.id,JSON.parse(c.function.arguments).path]),[['a','a'],['b','b']]);
});
test('review: provider truncation cannot yield executable tool calls',async()=>{
 const body=delta({tool_calls:[{index:0,id:'a',function:{name:'write_file',arguments:'{"path":"x"}'}}]});
 await assert.rejects(request(body+end('length')),/stopped/);
 await assert.rejects(request(body+frame({choices:[{delta:{},finish_reason:'tool_calls'}]})),/interrupted/);
});
test('review: duplicate IDs and invalid indexes fail closed',async()=>{
 await assert.rejects(request(delta({tool_calls:[{index:0,id:'a',function:{name:'x',arguments:'{}'}},{index:1,id:'a',function:{name:'x',arguments:'{}'}}]})+end('tool_calls')),/invalid tool calls/);
 await assert.rejects(request(delta({tool_calls:[{index:-1,id:'a'}]})+end('tool_calls')),/index/);
});
test('review: request disables redirects and forwards cancellation',async()=>{
 const controller=new AbortController(); controller.abort();
 await assert.rejects(request('',{signal:controller.signal,fetchImpl:async(url,options)=>{assert.equal(options.redirect,'error'); assert.equal(options.signal.aborted,true); assert.equal(new URL(url).pathname,'/api/coding/paas/v4/chat/completions'); options.signal.throwIfAborted();}}),{name:'AbortError'});
});
