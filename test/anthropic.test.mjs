import test from 'node:test';
import assert from 'node:assert/strict';
import {anthropicEndpointURL, anthropicRequest, completeAnthropic} from '../src/anthropic.mjs';
const frames = (events) => new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), {headers: {'content-type': 'text/event-stream'}});
const start = {type: 'message_start', message: {usage: {input_tokens: 8}}};
const finish = reason => [{type: 'message_delta', delta: {stop_reason: reason}, usage: {output_tokens: 2}}, {type: 'message_stop'}];
const text = [{type: 'content_block_start', index: 0, content_block: {type: 'text', text: ''}}, {type: 'content_block_delta', index: 0, delta: {type: 'text_delta', text: 'hello'}}, {type: 'content_block_stop', index: 0}];
const tool = [{type: 'content_block_start', index: 1, content_block: {type: 'tool_use', id: 'call1', name: 'read_file', input: {}}}, {type: 'content_block_delta', index: 1, delta: {type: 'input_json_delta', partial_json: '{"path":"x"}'}}, {type: 'content_block_stop', index: 1}];
const options = {apiKey: 'test-secret', baseURL: 'https://api.z.ai/api/anthropic', model: 'GLM-5.3-Flash', messages: [{role: 'user', content: 'hi'}]};
test('Anthropic URLs append v1 once and reject credential leakage/remote HTTP', () => {
 assert.equal(anthropicEndpointURL(options.baseURL).href, 'https://api.z.ai/api/anthropic/v1/messages');
 assert.equal(anthropicEndpointURL(options.baseURL+'/v1/').href, 'https://api.z.ai/api/anthropic/v1/messages');
 for (const url of ['http://example.com', 'https://user:pass@example.com', 'https://example.com?k=secret', 'https://example.com/#secret']) assert.throws(() => anthropicEndpointURL(url));
});
test('Anthropic schema maps tools, system, consecutive tool results and GLM effort', () => {
 const body = anthropicRequest({...options, tools: [{type:'function',function:{name:'read_file',description:'read',parameters:{type:'object'}}}], messages: [{role:'system',content:'s'}, {role:'assistant',content:null,tool_calls:[{id:'a',function:{name:'read_file',arguments:'{}'}}]}, {role:'tool',tool_call_id:'a',content:'result'}, {role:'tool',tool_call_id:'b',content:'result2'}]});
 assert.deepEqual(body.thinking,{type:'enabled'}); assert.deepEqual(body.output_config,{effort:'high'});
 assert.equal(body.system[0].text,'s'); assert.equal(body.messages[0].content[0].type,'tool_use');
 assert.equal(body.messages[1].content.length,2); assert.equal(body.tools[0].input_schema.type,'object');
 assert.equal(body.reasoning_effort,undefined);
});
test('Anthropic streaming returns text and safe public client headers', async () => {
 let shown='';
 const result=await completeAnthropic({...options,onText:t=>shown+=t,fetchImpl:async(url,init)=>{
  assert.equal(url.href,'https://api.z.ai/api/anthropic/v1/messages'); assert.equal(init.redirect,'error');
  assert.equal(init.headers['x-api-key'],'test-secret'); assert.equal(init.headers.Authorization,'Bearer test-secret');
  assert.equal(init.headers['anthropic-version'],'2023-06-01'); assert.equal(init.headers['X-ZCode-App-Version'],undefined);
  return frames([start,...text,...finish('end_turn')]);
 }});
 assert.equal(shown,'hello'); assert.equal(result.message.content,'hello'); assert.deepEqual(result.usage,{prompt_tokens:8,completion_tokens:2});
});
test('Anthropic tool calls only return after terminal completion',async()=>{
 const result=await completeAnthropic({...options,fetchImpl:async()=>frames([start,...tool,...finish('tool_use')])});
 assert.equal(result.message.tool_calls[0].function.arguments,'{"path":"x"}');
 for(const events of [[start,...tool], [start,...tool,...finish('max_tokens')], [start,...tool,...finish('end_turn')], [start,...tool.slice(0,2),...finish('tool_use')]]) await assert.rejects(completeAnthropic({...options,fetchImpl:async()=>frames(events)}));
});
test('Anthropic signed thinking round trips without inventing signatures',async()=>{
 const events=[start,{type:'content_block_start',index:0,content_block:{type:'thinking',thinking:''}}, {type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'think'}}, {type:'content_block_delta',index:0,delta:{type:'signature_delta',signature:'sig'}}, {type:'content_block_stop',index:0},...tool,...finish('tool_use')];
 const {message}=await completeAnthropic({...options,fetchImpl:async()=>frames(events)});
 const body=anthropicRequest({...options,messages:[message]}); assert.deepEqual(body.messages[0].content[0],{type:'thinking',thinking:'think',signature:'sig'});
});
test('Anthropic error messages redact keys and reject malformed/invalid blocks',async()=>{
 await assert.rejects(completeAnthropic({...options,fetchImpl:async()=>new Response(JSON.stringify({error:{code:'1302',message:'limited test-secret'}}),{status:429})}),e=>e.message.includes('1302')&&!e.message.includes('test-secret'));
 for(const events of [[start,{type:'error',error:{message:'test-secret'}}], [start,{type:'content_block_stop',index:0}], [start,...text,{type:'content_block_start',index:0,content_block:{type:'text',text:''}}]]) await assert.rejects(completeAnthropic({...options,fetchImpl:async()=>frames(events)}),e=>!e.message.includes('test-secret'));
});
