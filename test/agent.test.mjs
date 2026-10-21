import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, readdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZaiBackend } from '../src/backends/zai.mjs';
import { Sessions } from '../src/sessions.mjs';
import { validateConfig } from '../src/config.mjs';
import { id } from '../src/util.mjs';

function reply(content, calls = []) {
  const message = { content, ...(calls.length ? { tool_calls: calls.map((c,index) => ({ index, id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) } : {}) };
  const text = 'data: ' + JSON.stringify({ choices: [{ delta: message, finish_reason: calls.length ? 'tool_calls' : 'stop' }] }) + '\n\n' + 'data: [DONE]\n\n';
  return new Response(text, { headers: { 'content-type': 'text/event-stream' } });
}
async function fixture(t, responses, ask = async () => true) {
  const base = await mkdtemp(join(tmpdir(), 'zc-agent-')), cwd = join(base, 'project');
  const { mkdir } = await import('node:fs/promises'); await mkdir(cwd);
  t.after(() => rm(base, { recursive: true, force: true }));
  const previous = process.env.ZAI_API_KEY; process.env.ZAI_API_KEY = 'test-fixture-api-key-not-real';
  t.after(() => { if (previous === undefined) delete process.env.ZAI_API_KEY; else process.env.ZAI_API_KEY = previous; });
  const events = [], requests = [], sessions = new Sessions(cwd, join(base, 'state'));
  const backend = new ZaiBackend({ cwd, config: validateConfig({ backend: 'zai' }), sessions, ask, emit: e => events.push(e), fetchImpl: async (url, request) => {
    requests.push({ url, ...request });
    const response = responses.shift(); if (!response) throw new Error('Unexpected extra model request');
    return typeof response === 'function' ? await response(url, request) : response;
  } });
  return { backend, cwd, sessions, requests, events, base };
}
test('agent executes a real read tool and returns its result in the next model turn', async t => {
  const f = await fixture(t, [reply('', [{ id: 'read1', name: 'read_file', args: { path: 'a.ts', start_line: 1, max_lines: 20 } }]), reply('The file exports answer = 42.')]);
  await writeFile(join(f.cwd, 'a.ts'), 'export const answer = 42;');
  await f.backend.start(); await f.backend.send('Explain a.ts');
  const second = JSON.parse(f.requests[1].body);
  assert.match(second.messages.find(m => m.role === 'tool').content, /answer = 42/);
  assert.equal(f.requests[0].headers.authorization, 'Bearer test-fixture-api-key-not-real');
  assert.equal(f.requests[0].redirect, 'error');
  assert.equal(f.events.filter(e => e.type === 'tool' && e.status === 'done').length, 1);
});
test('agent performs an approved create_file and persists the tool result', async t => {
  let approvals = 0;
  const f = await fixture(t, [reply('', [{ id: 'write1', name: 'create_file', args: { path: 'new.ts', content: 'export const answer = 42;\n' } }]), reply('Created new.ts.')], async () => { approvals++; return true; });
  await f.backend.start(); await f.backend.send('Create the file.');
  assert.equal(approvals, 1); assert.equal(await readFile(join(f.cwd, 'new.ts'), 'utf8'), 'export const answer = 42;\n');
  const session = await f.sessions.load(f.backend.session.id);
  assert.equal(session.inFlight, false); assert.ok(session.messages.some(m => m.role === 'tool' && /Created/.test(m.content)));
});
test('denied tools produce no mutation and send an explicit denial to the model', async t => {
  const f = await fixture(t, [reply('', [{ id: 'denied', name: 'create_file', args: { path: 'no.ts', content: 'no' } }]), reply('No changes were made.')], async () => false);
  await f.backend.start(); await f.backend.send('Request a file.');
  await assert.rejects(access(join(f.cwd, 'no.ts')));
  assert.match(JSON.parse(f.requests[1].body).messages.find(m => m.role === 'tool').content, /denied/);
});
test('HTTP authentication errors are actionable and are not retried', async t => {
  const f = await fixture(t, [new Response('', { status: 401 })]); await f.backend.start();
  await assert.rejects(f.backend.send('hello'), /HTTP 401.*ZAI_API_KEY/); assert.equal(f.requests.length, 1);
});
test('partial model streams cannot execute a pending write', async t => {
  const incomplete = 'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'x', function: { name: 'create_file', arguments: JSON.stringify({ path: 'unsafe', content: 'no' }) } }] } }] }) + '\n\n';
  const f = await fixture(t, [new Response(incomplete, { headers: { 'content-type': 'text/event-stream' } })]); await f.backend.start();
  await assert.rejects(f.backend.send('try'), /without a complete answer/); await assert.rejects(access(join(f.cwd, 'unsafe')));
  assert.equal(f.requests.length, 1);
});
test('interrupted session resume forks history and never replays unresolved tools', async t => {
  const f = await fixture(t, []);
  const old = f.sessions.create('glm-5.3'); old.inFlight = true;
  old.messages = [{ role: 'user', content: 'create' }, { role: 'assistant', content: null, tool_calls: [{ id: 'pending', type: 'function', function: { name: 'create_file', arguments: '{"path":"no","content":"no"}' } }] }];
  await f.sessions.save(old); await f.backend.start(old.id);
  assert.notEqual(f.backend.session.id, old.id); assert.equal(f.requests.length, 0);
  assert.match(f.backend.session.messages.at(-1).content, /Execution may or may not have occurred/);
  assert.equal((await f.sessions.load(old.id)).inFlight, true);
});
test('session IDs and workspace identity cannot traverse storage boundaries', async t => {
  const f = await fixture(t, []);
  assert.throws(() => f.sessions.path('../../config'), /Invalid session/);
  const session = f.sessions.create('glm-5.3'); session.cwd = '/different'; await assert.rejects(f.sessions.save(session), /different workspace/);
});
test('known API credentials are redacted from persisted sessions', async t => {
  const f = await fixture(t, [reply('test-fixture-api-key-not-real')]); await f.backend.start(); await f.backend.send('hello');
  const saved = await readFile(f.sessions.path(f.backend.session.id), 'utf8');
  assert.doesNotMatch(saved, /test-fixture-api-key-not-real/); assert.match(saved, /REDACTED/);
});
test('compaction retains the original session as a separate branch', async t => {
  const f = await fixture(t, [reply('We inspected a.ts. No changes were made.')]); await f.backend.start();
  const previous = f.backend.session.id; await f.backend.compact();
  assert.notEqual(f.backend.session.id, previous); assert.equal((await f.sessions.load(previous)).id, previous);
  assert.equal(f.backend.session.parentId, previous);
});

test('empty compaction summaries do not replace the original history', async t => {
  const f = await fixture(t, [reply('   ')]); await f.backend.start();
  const original = f.backend.session.id;
  await assert.rejects(f.backend.compact(), /empty summary/);
  assert.equal(f.backend.session.id, original); assert.equal(f.backend.running, false);
});
test('compaction holds an execution lock until the provider request settles', async t => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, [async () => { await pending; return reply('Retained context.'); }]);
  await f.backend.start(); const compacting = f.backend.compact();
  await assert.rejects(f.backend.send('concurrent'), /already running/);
  await assert.rejects(f.backend.setMode('read-only'), /Stop the current turn/);
  await assert.rejects(f.backend.setModel('other'), /Stop the current turn/);
  release(); await compacting; assert.equal(f.backend.running, false);
});
test('invalid permission modes do not alter tool policy', async t => {
  const f = await fixture(t, []); await f.backend.start();
  await assert.rejects(f.backend.setMode('yolo'), /mode must be/);
  assert.equal(f.backend.tools.mode, 'ask');
});
