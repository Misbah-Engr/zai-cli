import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const cli=resolve('src/cli.mjs');
function run(args, env) {return new Promise(resolve=>{const child=spawn(process.execPath,[cli,'--backend','api',...args],{env:{...process.env,...env}});let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);child.on('close',code=>resolve({code,stdout,stderr}));});}
test('CLI reads approved file through mock API and streams final answer',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'zai-e2e-'));await writeFile(join(dir,'hello.txt'),'hello world');let requests=[];
 const server=createServer(async(req,res)=>{let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text);requests.push(body);assert.equal(req.headers.authorization,'Bearer local-test');res.writeHead(200,{'Content-Type':'text/event-stream'});
 const delta=requests.length===1?{tool_calls:[{index:0,id:'read1',type:'function',function:{name:'read_file',arguments:'{"path":"hello.txt"}'}}]}:{content:'The file says hello world.'};
 res.write(`data: ${JSON.stringify({choices:[{delta}]})}\n\n`);res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try {const result=await run(['--cwd',dir,'--allow-read','--no-save','-p','Read hello.txt'],{ZAI_API_KEY:'local-test',ZAI_BASE_URL:`http://127.0.0.1:${server.address().port}/v1`,ZAI_PROFILE:'coding'});assert.equal(result.code,0,result.stderr);assert.match(result.stdout,/hello world/);assert.equal(requests.length,2);assert.match(requests[1].messages.find(m=>m.role==='tool').content,/hello world/);assert.match(result.stderr,/coding/);}
 finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
test('help and doctor work without an API key',async()=>{assert.equal((await run(['--help'],{ZAI_API_KEY:''})).code,0);assert.match((await run(['doctor'],{ZAI_API_KEY:''})).stderr,/missing/);});
test('noninteractive invocation refuses unsafe command paths',async()=>{const result=await run(['--prompt','hello'],{ZAI_API_KEY:'',ZAI_PROFILE:'coding'});assert.equal(result.code,1);assert.match(result.stderr,/ZAI_API_KEY/);});
