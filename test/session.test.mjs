import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {newSession,saveSession,loadSession,listSessions} from '../src/session.mjs';
test('sessions persist, list, and bind to workspace', async()=>{
 const dir=await mkdtemp(join(tmpdir(),'zai-session-')); process.env.ZAI_HOME=dir;
 try {const s=newSession(dir); s.messages.push({role:'user',content:'hello'}); await saveSession(s); assert.deepEqual(await loadSession(s.id,dir),s); assert.equal((await listSessions()).length,1); await assert.rejects(loadSession(s.id,join(dir,'other')),/workspace/); await assert.rejects(loadSession('../secret',dir),/Invalid/);}
 finally {delete process.env.ZAI_HOME;await rm(dir,{recursive:true,force:true});}
});
