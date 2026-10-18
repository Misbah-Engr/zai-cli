import test from 'node:test';
import assert from 'node:assert/strict';
import {complete, providerHTTPError, providerDetail} from '../src/provider.mjs';
const apiKey = 'private-api-key-12345';
const options = {apiKey, baseURL:'https://api.z.ai/api/coding/paas/v4', model:'glm-5.2', messages:[], tools:[]};
const request = response => complete({...options, fetchImpl:async()=>response});
const json = (value, status=429, headers={}) => new Response(JSON.stringify(value), {status, headers:{'content-type':'application/json', ...headers}});
test('429 retains provider code and reason without guessing quota or retrying', async()=>{
 let requests=0;
 await assert.rejects(complete({...options, fetchImpl:async()=>{requests++;return json({error:{code:'1302',message:'Too many concurrent requests'}});}}), error=>{
  assert.match(error.message,/HTTP 429/); assert.match(error.message,/1302/); assert.match(error.message,/Too many concurrent requests/);
  assert.match(error.message,/does not establish the cause/); assert.doesNotMatch(error.message,/quota reached|Try again later/); return true;
 });
 assert.equal(requests,1);
});
test('only selected scalar fields are shown; raw HTML, malformed JSON, arrays and arbitrary fields are hidden', async()=>{
 for(const body of ['<html>private body</html>', '{broken private body', JSON.stringify({debug:'private body'}), JSON.stringify({error:{code:{secret:'private body'},message:['private body']}}), JSON.stringify(['private body'])]) {
  const error=await providerHTTPError(new Response(body,{status:401}),apiKey);
  assert.match(error.message,/HTTP 401/); assert.doesNotMatch(error.message,/private body/);
 }
});
test('credentials, URLs, ANSI, control characters and bidi text are sanitized before truncation',()=>{
 const detail=providerDetail({error:{code:'1302',message:`${apiKey} ${encodeURIComponent(apiKey)} Bearer abcdef password="hide me" api_key=other-secret sk-private123 https://host.test/?key=private aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \x1b[31mred\x1b[0m\n\r\u202eend`}},apiKey);
 for(const secret of [apiKey,'abcdef','hide me','other-secret','sk-private123','host.test','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']) assert.ok(!detail.includes(secret),secret);
 assert.doesNotMatch(detail,/[\x00-\x1f\x7f-\x9f\u202e]/); assert.ok(detail.length<350); assert.match(detail,/redacted/);
});
test('error output is bounded and credentials crossing truncation are hidden',()=>{
 const detail=providerDetail({error:{code:'x'.repeat(500),message:'a '.repeat(115)+apiKey+' end '.repeat(500)}},apiKey);
 assert.ok(detail.length<350); assert.ok(!detail.includes('private-api'));
});
test('oversized error bodies are cancelled instead of printed',async()=>{
 let cancelled=false;
 const body=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('x'.repeat(16385)));},cancel(){cancelled=true;}});
 const error=await providerHTTPError(new Response(body,{status:429}),apiKey);
 assert.equal(cancelled,true); assert.ok(error.message.length<300);
});
test('Retry-After supports seconds and HTTP dates; invalid text is not echoed',async()=>{
 for(const [value, expected] of [['30','Retry-After: 30 seconds'],['Wed, 21 Oct 2026 07:28:00 GMT','Retry-After: 2026-10-21T07:28:00.000Z']]) {
  const error=await providerHTTPError(json({},429,{'retry-after':value}),apiKey); assert.ok(error.message.includes(expected));
 }
 const error=await providerHTTPError(json({},429,{'retry-after':'secret invalid header'}),apiKey);assert.doesNotMatch(error.message,/secret invalid|Retry-After/);
});
test('JSON responses with HTTP 200 surface sanitized structured provider errors',async()=>{
 await assert.rejects(request(json({error:{code:1004,message:'Invalid model access'}},200)),/Expected an SSE.*1004.*Invalid model access/);
});
test('SSE errors surface sanitized provider code and message',async()=>{
 const body=`data: ${JSON.stringify({error:{code:1305,message:`Access denied ${apiKey}`}})}\n\n`;
 await assert.rejects(request(new Response(body,{headers:{'content-type':'text/event-stream'}})),error=>{
  assert.match(error.message,/while streaming.*1305.*Access denied/);assert.ok(!error.message.includes(apiKey));return true;
 });
});
test('malformed JSON value in SSE fails closed without a TypeError',async()=>{
 await assert.rejects(request(new Response('data: null\n\n',{headers:{'content-type':'text/event-stream'}})),/malformed stream JSON/);
});
test('provider field aliases are recognized',()=>{
 assert.match(providerDetail({error:{error_code:1301,msg:'Account access denied'}},apiKey),/1301.*Account access denied/);
 assert.match(providerDetail({providerCode:1302,message:'Concurrency limit'},apiKey),/1302.*Concurrency limit/);
});
test('SSE event:error and business error envelopes fail closed with details',async()=>{
 for (const body of [
  'event: error\ndata: {"code":"1302","message":"Concurrency limit"}\n\n',
  'data: {"success":false,"msg":"Concurrency limit"}\n\n',
  'data: {"code":1302,"message":"Concurrency limit"}\n\n',
  'data: {"type":"error","message":"Concurrency limit"}\n\n'
 ]) await assert.rejects(request(new Response(body,{headers:{'content-type':'text/event-stream'}})),/while streaming.*Concurrency limit/);
});
test('unknown finish reasons are never echoed into terminal diagnostics',async()=>{
 const body=`data: ${JSON.stringify({choices:[{delta:{},finish_reason:apiKey+'\x1b[31m'}]})}\n\ndata: [DONE]\n\n`;
 await assert.rejects(request(new Response(body,{headers:{'content-type':'text/event-stream'}})),error=>{
  assert.match(error.message,/unsupported finish reason/);assert.ok(!error.message.includes(apiKey));return true;
 });
});
