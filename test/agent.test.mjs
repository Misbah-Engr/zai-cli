import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runTurn} from '../src/agent.mjs';
import {newSession} from '../src/session.mjs';
const tool=(id,name,args)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
test('agent denies unapproved writes and provides denial to model', async()=>{
 const cwd=await mkdtemp(join(tmpdir(),'zai-agent-')); const session=newSession(cwd); let n=0;
 try {await runTurn({session,prompt:'write a file',config:{maxTools:2},provider:async({messages})=>{
 if(n++===0)return {message:{role:'assistant',content:null,tool_calls:[tool('w1','write_file',{path:'a.txt',content:'hello'})]}};
 assert.match(messages.at(-1).content,/Permission denied/);return {message:{role:'assistant',content:'The write was denied.'}};
 }});await assert.rejects(readFile(join(cwd,'a.txt')),/ENOENT/);assert.equal(n,2);}
 finally{await rm(cwd,{recursive:true,force:true});}
});
test('tool budget does not execute excess calls and leaves valid result pairs',async()=>{
 const session=newSession(process.cwd()); let approvals=0;
 await assert.rejects(runTurn({session,prompt:'list twice',config:{maxTools:1},approve:async()=>{approvals++;return false;},provider:async()=>({message:{role:'assistant',content:null,tool_calls:[tool('a','list_files',{}),tool('b','list_files',{})]}})}),/budget/);
 assert.equal(approvals,1);assert.equal(session.messages.filter(m=>m.role==='tool').length,2);
});
test('provider failure rolls back unanswered user turn',async()=>{
 const session=newSession(process.cwd());await assert.rejects(runTurn({session,prompt:'hi',config:{maxTools:1},provider:async()=>{throw new Error('offline');}}),/offline/);assert.equal(session.messages.length,0);
});
