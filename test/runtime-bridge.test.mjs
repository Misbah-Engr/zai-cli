import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { RuntimeBridge, resolveRuntimeLaunch } from '../src/runtime-bridge.mjs';

function harness(options = {}) {
  const sent = [];
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = signal => { child.killed = signal; child.emit('close', null, signal); };
  child.stdin = new Writable({ write(chunk, encoding, callback) {
    for (const line of chunk.toString().trim().split('\n')) sent.push(JSON.parse(line));
    callback();
  }});
  let spawnArgs;
  const bridge = new RuntimeBridge({ cwd: '/tmp', ...options,
    spawnImpl(...args) { spawnArgs = args; return child; } });
  const receive = message => child.stdout.write(JSON.stringify(message) + '\n');
  const reply = (request, result) => receive({ id: request.id, result });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  async function session({ resume = false } = {}) {
    const promise = bridge.startSession(resume ? { resumeSessionId: 's1' } : {});
    reply(sent.at(-1), { protocol: { name: 'ZCode Protocol', version: 1 }, session: { sessionId: 's1' } });
    await flush();
    if (resume) { assert.equal(sent.at(-1).method, 'session/setMode'); reply(sent.at(-1), {}); await flush(); }
    assert.equal(sent.at(-1).method, 'session/subscribe');
    reply(sent.at(-1), { sessionId: 's1', events: [], eventSeq: 0 });
    await promise;
  }
  return { bridge, child, sent, receive, reply, flush, session, spawnArgs: () => spawnArgs };
}

test('starts installed launcher in standalone mode and creates guarded session', async () => {
  const h = harness({ env: { ZCODE_APP_SERVER_AUTH_MODE: 'host' } });
  await h.session();
  assert.deepEqual(h.spawnArgs().slice(0, 2), ['zcode', ['app-server']]);
  assert.equal(h.spawnArgs()[2].env.ZCODE_APP_SERVER_AUTH_MODE, 'standalone');
  assert.equal(h.spawnArgs()[2].shell, false);
  assert.deepEqual(h.sent[0].params, { workspace: { workspacePath: '/tmp', workspaceKey: '/tmp' }, mode: 'guarded' });
  assert.equal(h.sent[1].params.deliveryKind, 'desktop-continuous');
  h.bridge.close();
});

test('streams UTF8 deltas, excludes duplicate and reasoning text, waits for terminal turn', async () => {
  const h = harness(); await h.session();
  const texts = [], thoughts = [], tools = [];
  h.bridge.on('text', value => texts.push(value)); h.bridge.on('reasoning', value => thoughts.push(value));
  h.bridge.on('tool', value => tools.push(value));
  const done = h.bridge.send('hello'); const request = h.sent.at(-1);
  h.reply(request, { accepted: true });
  const event = (seq, type, payload) => ({ method: 'session/event', params: { sessionId: 's1', seq, type, payload } });
  const wire = Buffer.from(JSON.stringify(event(1, 'model.streaming', { kind: 'text_delta', delta: 'héllo' })) + '\n');
  const offset = wire.indexOf(Buffer.from('é')) + 1;
  h.child.stdout.write(wire.subarray(0, offset)); h.child.stdout.write(wire.subarray(offset));
  h.receive(event(1, 'model.streaming', { kind: 'text_delta', delta: 'duplicate' }));
  h.receive(event(2, 'model.streaming', { kind: 'reasoning_delta', delta: 'thought' }));
  h.receive(event(3, 'tool.updated', { kind: 'scheduled', toolName: 'Read' }));
  h.receive(event(4, 'turn.completed', { inputId: request.params.inputId, response: 'héllo', resultType: 'success' }));
  assert.equal((await done).response, 'héllo'); assert.deepEqual(texts, ['héllo']); assert.deepEqual(thoughts, ['thought']);
  assert.equal(tools[0].toolName, 'Read'); h.bridge.close();
});

test('denies tool requests by default and deduplicates reannounced approvals', async () => {
  const h = harness(); h.bridge.start();
  h.receive({ id: 'server-1', method: 'interaction/requestPermission', params: { requestId: 'p1', toolName: 'Bash' } });
  await h.flush(); assert.equal(h.sent.at(-1).result.decision, 'deny'); h.bridge.close();
  let calls = 0;
  const a = harness({ onPermission: async () => { calls++; return { decision: 'allow', permissionUpdates: ['never-forward'] }; } });
  a.bridge.start();
  for (const id of ['server-1', 'server-2']) a.receive({ id, method: 'interaction/requestPermission', params: { requestId: 'p1', sessionId: 's1', toolCallId: 't1', toolName: 'Bash', input: {}, riskLevel: 'high', reason: 'Run command', options: [{ kind: 'allow_once' }] } });
  await a.flush(); assert.equal(calls, 1); assert.equal(a.sent.length, 2);
  assert.equal(a.sent[0].result.decision, 'allow'); assert.equal(a.sent[0].result.permissionUpdates, undefined); a.bridge.close();
});

test('unknown interactions fail closed, user input cancels by default', async () => {
  const h = harness(); h.bridge.start();
  h.receive({ id: 'server-1', method: 'interaction/requestProviderRuntimeHeaders', params: {} });
  h.receive({ id: 'server-2', method: 'interaction/requestUserInput', params: {} });
  await h.flush();
  assert.equal(h.sent.find(x => x.id === 'server-1').error.code, -32601);
  assert.deepEqual(h.sent.find(x => x.id === 'server-2').result, { action: 'cancel' }); h.bridge.close();
});

test('AbortSignal uses native stop without deleting the session', async () => {
  const h = harness(); await h.session(); const controller = new AbortController();
  const done = h.bridge.send('hello', { signal: controller.signal });
  const send = h.sent.at(-1); h.reply(send, { accepted: true }); await h.flush(); controller.abort();
  assert.equal(h.sent.at(-1).method, 'session/stop'); h.reply(h.sent.at(-1), {});
  h.receive({ method: 'session/event', params: { sessionId: 's1', seq: 1, type: 'turn.completed', payload: { inputId: send.params.inputId, response: '', resultType: 'cancelled' } } });
  assert.equal((await done).resultType, 'cancelled'); h.bridge.close();
  assert.ok(!h.sent.some(x => x.method === 'session/close'));
});

test('resumed sessions explicitly return to guarded mode', async () => {
  const h = harness(); await h.session({ resume: true });
  assert.deepEqual(h.sent[1].params, { sessionId: 's1', mode: 'guarded' }); h.bridge.close();
});

test('turn failure, malformed JSON, oversized messages, and process exit reject pending work', async () => {
  const h = harness(); await h.session(); const done = h.bridge.send('hello'); h.reply(h.sent.at(-1), { accepted: true });
  h.receive({ method: 'session/event', params: { sessionId: 's1', seq: 1, type: 'turn.failed', payload: { error: { message: 'quota' } } } });
  await assert.rejects(done, /quota/); h.bridge.close();
  for (const fault of ['json', 'size', 'exit']) {
    const h = harness({ maxLineBytes: 100 }); const request = h.bridge.request('session/list');
    if (fault === 'json') h.child.stdout.write('{invalid}\n');
    if (fault === 'size') h.child.stdout.write('x'.repeat(101));
    if (fault === 'exit') h.child.emit('close', 2, null);
    await assert.rejects(request, /Invalid NDJSON|size limit|exited/);
  }
});

test('lists without creating a session and rejects unsupported runtime version', async () => {
  const h = harness(); const listing = h.bridge.request('session/list', {}); h.reply(h.sent.at(-1), { sessions: [] });
  assert.deepEqual(await listing, { sessions: [] }); assert.equal(h.sent.length, 1); h.bridge.close();
  const a = harness(); const startup = a.bridge.startSession();
  a.reply(a.sent[0], { protocol: { name: 'ZCode Protocol', version: 99 }, session: { sessionId: 's1' } });
  await assert.rejects(startup, /Unsupported/); a.bridge.close();
});

 test('rejects malformed permission before callback and launches explicit JS without shell', async () => {
  let calls = 0;
  const h = harness({ command: '/tmp/bin/zcode.js', onPermission: () => { calls++; return {decision: 'allow'}; } });
  h.bridge.start(); assert.equal(h.spawnArgs()[0], process.execPath);
  assert.deepEqual(h.spawnArgs()[1], ['/tmp/bin/zcode.js', 'app-server']);
  h.receive({ id: 'server-1', method: 'interaction/requestPermission', params: {} });
  await h.flush(); assert.equal(calls, 0); assert.equal(h.sent.at(-1).result.decision, 'deny'); h.bridge.close();
  const w = harness({ platform: 'win32' });
  await assert.rejects(w.bridge.request('session/list'), /runtime-path/);
  const c = harness({ command: '/tmp/zcode.cmd' });
  await assert.rejects(c.bridge.request('session/list'), /shell shim/);
});

 test('request timeout fails closed instead of permitting an overlapping unknown turn', async () => {
  const h = harness({ requestTimeoutMs: 5 });
  const keepAlive = setTimeout(() => {}, 100);
  await assert.rejects(h.bridge.request('session/list'), /timed out/);
  assert.equal(h.bridge.closed, true); assert.equal(h.child.killed, 'SIGTERM'); clearTimeout(keepAlive);
});

 test('discovers Windows npm installed entry without shell shims', () => {
  const entry = 'C:\\Users\\me\\npm\\node_modules\\zcode-app-cli\\bin\\zcode.js';
  const launch = resolveRuntimeLaunch('zcode', { platform: 'win32', env: { Path: 'C:\\Users\\me\\npm' }, isFile: path => path === entry });
  assert.deepEqual(launch, { command: process.execPath, args: [entry, 'app-server'] });
});

test('cancellation is bounded when stop acknowledges but emits no terminal event', async () => {
  const h = harness({ cancellationTimeoutMs: 10 }); await h.session();
  const controller = new AbortController();
  const done = h.bridge.send('hello', {signal: controller.signal});
  h.reply(h.sent.at(-1), {accepted: true}); await h.flush();
  controller.abort(); h.reply(h.sent.at(-1), {});
  await assert.rejects(done, /cancellation timed out/);
  assert.equal(h.bridge.closed, true); assert.equal(h.child.killed, 'SIGTERM');
  assert.ok(!h.sent.some(x => x.method === 'session/close'));
});

test('failed transport and explicit close escalate a SIGTERM-ignoring child', async () => {
  for (const fault of ['protocol', 'close']) {
    const h = harness({ shutdownTimeoutMs: 10 }); h.bridge.start();
    const signals = [];
    h.child.kill = signal => { signals.push(signal); if (signal === 'SIGKILL') h.child.emit('close', null, signal); };
    if (fault === 'protocol') h.child.stdout.write('{invalid}\n');
    h.bridge.close();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  }
});

test('approval deduplication cannot reuse permission for changed tool input', async () => {
  let calls = 0;
  const h = harness({ onPermission: () => ({decision: ++calls === 1 ? 'allow' : 'deny'}) });
  h.bridge.start();
  const params = {requestId: 'p1', sessionId: 's1', toolCallId: 't1', toolName: 'Bash', input: {command: 'first'}, riskLevel: 'high', reason: 'Run', options: [{kind: 'allow_once'}]};
  h.receive({id: 'one', method: 'interaction/requestPermission', params}); await h.flush();
  h.receive({id: 'two', method: 'interaction/requestPermission', params: {...params, input: {command: 'changed'}}}); await h.flush();
  assert.equal(calls, 2); assert.equal(h.sent.at(-1).result.decision, 'deny'); h.bridge.close();
});

test('POSIX shutdown kills runtime descendants even after launcher exits', {skip: process.platform === 'win32'}, async () => {
  const {mkdtemp, writeFile, rm, readFile} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'runtime-cleanup-'));
  const entry = join(dir, 'launcher.mjs');
  await writeFile(entry, `import {spawn} from 'node:child_process';
    const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{}); console.log(JSON.stringify({method:'ready',params:{pid:process.pid}})); setInterval(()=>{},1000)"],{stdio:['ignore','inherit','inherit']});
    process.on('SIGTERM',()=>process.exit(0));`);
  const bridge = new RuntimeBridge({command: entry, shutdownTimeoutMs: 30});
  try {
    const ready = new Promise(resolve => bridge.once('notification', resolve));
    bridge.start();
    const pid = (await ready).params.pid;
    bridge.close();
    await new Promise(resolve => setTimeout(resolve, 100));
    let alive = true;
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; else throw error; }
    // Linux may retain a killed orphan briefly as a zombie until PID 1 reaps it.
    if (alive && process.platform === 'linux') {
      try { alive = !/State:\s+Z/.test(await readFile(`/proc/${pid}/status`, 'utf8')); } catch (error) { if (error.code === 'ENOENT') alive = false; else throw error; }
    }
    assert.equal(alive, false);
  } finally { bridge.close(); await rm(dir, {recursive: true, force: true}); }
});
