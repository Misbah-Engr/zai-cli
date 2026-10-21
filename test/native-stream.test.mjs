import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { StreamDecoder, StreamTurn, streamArguments, streamModel, streamErrorMessage, safeUsage, STREAM_DENIED_TOOLS } from '../src/backends/stream-contract.mjs';
import { NativeStreamBackend, probeStreamRuntime, runNativeStream } from '../src/backends/native-stream.mjs';
import { StreamStore } from '../src/backends/stream-store.mjs';
import { validateConfig } from '../src/config.mjs';
import { WorkspaceState } from '../src/state.mjs';
import { createBackend, TerminalApp } from '../src/ui/app.mjs';
import { renderFrame } from '../src/ui/render.mjs';
import { width, clean } from '../src/util.mjs';
import { runProcess } from '../src/process.mjs';
const fixture = fileURLToPath(new URL('./fixtures/native-stream.mjs', import.meta.url));
const bin = fileURLToPath(new URL('../bin/zc.mjs', import.meta.url));
const runtime = { command: process.execPath, args: [fixture] };
const model = 'account:zai-individual-coding-plan/GLM-5.3';
const secret = 'SHOULD_NOT_APPEAR_IN_DISPLAY_OR_STATE_12345';
async function dir(t) { const d = await mkdtemp(join(tmpdir(), 'zc-native-stream-')); t.after(() => rm(d, { recursive: true, force: true })); return d; }
function parser() {
  const state = new WorkspaceState(), events = [];
  const turn = new StreamTurn({ emit: e => { state.apply(e); events.push(e); } }); let seq = 0;
  const frame = (type, payload, extra = {}) => ({ type, sessionId: 'sess_test', turnId: 'turn_test', seq: ++seq, payload, ...extra });
  const start = () => turn.frame(frame('turn.started', {}));
  const done = () => turn.frame(frame('turn.completed', { resultType: 'success', response: 'ok' }));
  const result = extra => ({ type: 'result', sessionId: 'sess_test', turnId: 'turn_test', response: 'ok', projection: { status: 'idle' }, ...extra });
  return { state, events, turn, frame, start, done, result };
}
test('stream arguments pin guarded mode, exclusions, and exact account model', () => {
  const args = streamArguments({ model, text: 'read smoke.txt', sessionId: 'sess_saved' });
  assert.equal(args[args.indexOf('--mode') + 1], 'guarded'); assert.equal(args[args.indexOf('--model') + 1], model);
  assert.equal(args[args.indexOf('--disallowedTools') + 1], STREAM_DENIED_TOOLS.join(','));
  assert.equal(args[args.indexOf('--resume') + 1], 'sess_saved'); assert.ok(!args.includes('--continue')); assert.ok(!args.includes('yolo'));
});
test('shell metacharacters remain one literal prompt argument', () => {
  const text = 'Describe "$(touch /tmp/not-allowed)"; do not execute it';
  assert.equal(streamArguments({ model, text }).at(-1), text);
});
test('stream selection never guesses a provider or reasoning suffix', () => {
  assert.equal(streamModel(model), model);
  for (const invalid of ['', 'glm-5.3', 'x/y$max', 'x/y\n--mode yolo', 'x/y z']) assert.throws(() => streamModel(invalid));
});
test('blank, oversized, NUL, slash command, and unsafe resume inputs are rejected', () => {
  for (const text of ['', ' ', 'x'.repeat(24001), '\0', '/login', '  /custom-command']) assert.throws(() => streamArguments({ model, text }));
  assert.throws(() => streamArguments({ model, text: 'hi', sessionId: '../../credentials' }));
});
test('decoder handles all UTF-8 byte boundaries and a final line without newline', () => {
  const rows = [], d = new StreamDecoder(x => rows.push(x));
  const bytes = Buffer.from(JSON.stringify({ type: 'hello', text: '你好 👋' }) + '\r\n' + JSON.stringify({ type: 'tail' }));
  for (const byte of bytes) d.feed(Buffer.from([byte])); d.end();
  assert.deepEqual(rows, [{ type: 'hello', text: '你好 👋' }, { type: 'tail' }]); assert.throws(() => d.feed(' '));
});
test('decoder never reflects non-JSON or invalid frames in errors', () => {
  for (const bad of [secret, 'null', '[]', '{"other":"' + secret + '"}']) {
    assert.throws(() => new StreamDecoder(() => {}).feed(bad + '\n'), error => !error.message.includes(secret));
  }
});
test('decoder enforces incomplete-frame, complete-frame, turn, and count budgets', () => {
  assert.throws(() => new StreamDecoder(() => {}, { maxFrameBytes: 8 }).feed('x'.repeat(9)), /frame exceeded/);
  assert.throws(() => new StreamDecoder(() => {}, { maxFrameBytes: 8 }).feed('x'.repeat(9) + '\n'), /frame exceeded/);
  assert.throws(() => new StreamDecoder(() => {}, { maxBytes: 2 }).feed('123'), /turn byte/);
  const d = new StreamDecoder(() => {}, { maxFrames: 1 }); d.feed('{"type":"x"}\n'); assert.throws(() => d.feed('{"type":"x"}\n'), /event limit/);
});
test('diagnostic and reasoning payloads never reach the presentation state', () => {
  const p = parser(); p.start();
  p.turn.frame(p.frame('session.updated', { requestHeaders: { Authorization: secret }, error: secret }));
  p.turn.frame(p.frame('model.streaming', { kind: 'reasoning_delta', delta: secret }));
  assert.ok(!JSON.stringify(p.state.entries).includes(secret)); assert.equal(p.events.length, 0);
});
test('duplicate event sequences do not double append text', () => {
  const p = parser(); p.start(); const f = p.frame('model.streaming', { kind: 'text_delta', assistantMessageId: 'm', delta: 'ok' });
  p.turn.frame(f); p.turn.frame(f); p.done(); p.turn.frame(p.result()); p.turn.finish();
  assert.deepEqual(p.state.entries.filter(e => e.role === 'assistant').map(e => e.text), ['ok']);
});
test('tool input omitted in scheduling is recovered from the model tool-call event', () => {
  const p = parser(); p.start();
  p.turn.frame(p.frame('model.streaming', { kind: 'tool_call', toolCallId: 'r', toolName: 'Read', input: { file_path: 'smoke.txt' } }));
  p.turn.frame(p.frame('tool.updated', { kind: 'scheduled', toolCallId: 'r', inputOmitted: true }));
  p.turn.frame(p.frame('tool.updated', { kind: 'result', toolCallId: 'r', result: 'ok' }));
  const t = p.state.entries.find(e => e.role === 'tool'); assert.equal(t.name, 'Read'); assert.match(t.input, /smoke.txt/); assert.equal(t.status, 'done');
});
test('multiple assistant messages retain tool-separated commentary without duplicate final text', () => {
  const p = parser(); p.start();
  p.turn.frame(p.frame('model.streaming', { kind: 'text_delta', assistantMessageId: 'one', delta: 'Reading' }));
  p.turn.frame(p.frame('model.streaming', { kind: 'text_delta', assistantMessageId: 'two', delta: 'ok' }));
  p.done(); p.turn.frame(p.result()); p.turn.finish();
  assert.deepEqual(p.state.entries.map(e => e.text), ['Reading', 'ok']);
});
test('a result without successful completion is not treated as success', () => { const p = parser(); p.start(); assert.throws(() => p.turn.frame(p.result()), /successful/); });
test('a completed turn without a final result is not treated as success', () => { const p = parser(); p.start(); p.done(); assert.throws(() => p.turn.finish(), /without a verified/); });
test('foreign-session and foreign-turn results fail identity checks', () => {
  for (const extra of [{ sessionId: 'sess_foreign' }, { turnId: 'wrong' }, { response: 'other' }, { projection: { status: 'running' } }]) {
    const p = parser(); p.start(); p.done(); assert.throws(() => p.turn.frame(p.result(extra)));
  }
});
test('foreign child-session events cannot overwrite or complete the root conversation', () => {
  const p = parser(); p.start(); p.turn.frame(p.frame('turn.failed', { error: { message: secret } }, { sessionId: 'sess_child' }));
  p.done(); p.turn.frame(p.result()); assert.equal(p.turn.finish().response, 'ok');
});
test('unknown completion result types and runtime errors remain failures', () => {
  for (const resultType of ['cancelled', 'error_max_turns', 'invented', undefined]) {
    const p = parser(); p.start(); assert.throws(() => p.turn.frame(p.frame('turn.completed', { response: 'ok', resultType })));
  }
  const p = parser(); p.start(); assert.throws(() => p.turn.frame(p.frame('turn.failed', { error: { message: secret } })), e => !e.message.includes(secret));
});
test('post-result events and unexpected additional turns are rejected', () => {
  const p = parser(); p.start(); p.done(); p.turn.frame(p.result()); assert.throws(() => p.turn.frame(p.result()), /after its final/);
  const q = parser(); q.start(); assert.throws(() => q.start(), /additional headless turn/);
});
test('usage projection only includes known finite nonnegative integer fields', () => {
  assert.deepEqual(safeUsage({ totalTokens: 23582, inputTokens: -1, outputTokens: 2.5, secret, requestHeaders: { secret } }), { totalTokens: 23582 });
});
test('auth error classification is useful without including sensitive diagnostic details', () => {
  const message = streamErrorMessage('project_token_login_failed ' + secret);
  assert.match(message, /does not prove your login expired/); assert.ok(!message.includes('Exit and use'));  assert.ok(!message.includes(secret)); assert.equal(streamErrorMessage(secret), undefined);
});
test('version probe accepts the pinned wrapper and rejects an unrelated executable', async () => {
  assert.equal((await probeStreamRuntime(runtime, process.cwd())).client, '3.15.3-37');
  await assert.rejects(probeStreamRuntime({ command: process.execPath, args: [] }, process.cwd()), /did not report a supported pair/);
});
async function invoke(text, options = {}) {
  const state = new WorkspaceState(), events = [];
  const result = await runNativeStream({ runtime, cwd: process.cwd(), model, text,
    emit: e => { state.apply(e); events.push(e); }, idleTimeout: 1500, totalTimeout: 4000, shutdownMs: 100, ...options });
  return { result, state, events };
}
test('real subprocess stream maps tool and response while suppressing raw diagnostics', async () => {
  const { result, state, events } = await invoke('read smoke.txt');
  assert.equal(result.response, 'ZC_NATIVE_FILE_READ_OK'); assert.equal(state.entries.filter(e => e.role === 'assistant').length, 1);
  assert.equal(state.entries.find(e => e.role === 'tool').name, 'Read'); assert.ok(!JSON.stringify({ events, result }).includes(secret));
});
test('real subprocess UTF-8 fragmentation and no-newline result are accepted', async () => {
  assert.equal((await invoke('fragment')).result.response, 'Hello 你好 👋');
  assert.equal((await invoke('final-no-newline')).result.response, 'ZC_NATIVE_FILE_READ_OK');
});
for (const value of ['missing-result', 'wrong-session', 'extra-result', 'nonzero', 'bad-json', 'auth-error']) {
  test(`real subprocess ${value} cannot become a successful turn`, async () => { await assert.rejects(invoke(value), e => !e.message.includes(secret)); });
}
test('abort before launch does not spawn or submit a prompt', async () => {
  const c = new AbortController(); c.abort(); let spawned = 0;
  await assert.rejects(invoke('hi', { signal: c.signal, spawnImpl: () => { spawned++; } }), { name: 'AbortError' }); assert.equal(spawned, 0);
});
test('cancellation stops a real child process without replay', async () => {
  const c = new AbortController(); const timer = setTimeout(() => c.abort(), 120);
  try { await assert.rejects(invoke('wait', { signal: c.signal }), { name: 'AbortError' }); } finally { clearTimeout(timer); }
});
test('idle timeout escalates when the child ignores graceful termination', async () => {
  const start = Date.now(); await assert.rejects(invoke('wait-ignore', { idleTimeout: 200 }), /stopped sending/); assert.ok(Date.now() - start < 4000);
});
test('total timeout bounds a run independently of event activity', async () => { await assert.rejects(invoke('wait', { totalTimeout: 180 }), /total turn time/); });
async function backend(t, overrides = {}) {
  const cwd = await dir(t), events = [];
  const config = validateConfig({ backend: 'native-stream', mode: 'guarded', streamModel: model, runtime, ...overrides });
  const b = new NativeStreamBackend({ cwd, config, storeHome: join(cwd, 'state'), emit: e => events.push(e) });
  t.after(() => b.dispose()); return { cwd, config, b, events };
}
test('backend factory explicitly selects stream without changing legacy native', () => {
  assert.ok(createBackend({ cwd: process.cwd(), config: validateConfig({ backend: 'native-stream' }), emit: () => {} }) instanceof NativeStreamBackend);
});
test('stream refuses ask and read-only rather than silently weakening their meaning', async t => {
  for (const mode of ['ask', 'read-only']) { const { b } = await backend(t, { mode }); await assert.rejects(b.start(), /requires --mode guarded/); }
});
test('a missing model holds the prompt and does not invent a default', async t => {
  const { b, events } = await backend(t, { streamModel: '' }); assert.equal((await b.start()).needsModel, true);
  await assert.rejects(b.send('not sent'), /not sent/); assert.ok(!events.some(e => e.role === 'user'));
});
test('back-to-back sends use the exact returned session ID for conversation continuity', async t => {
  const { b } = await backend(t); await b.start(); await b.send('first');
  assert.equal(b.record.nativeSessionId, 'sess_fixture-stream'); await b.send('second');
  assert.equal(b.record.nativeSessionId, 'sess_fixture-stream'); assert.equal(b.record.status, 'idle');
  assert.equal(b.display.entries.filter(e => e.role === 'assistant').length, 2);
});
test('persisted display history excludes raw stderr, headers, reasoning, and unknown usage fields', async t => {
  const { b } = await backend(t); await b.start(); await b.send('hello');
  const saved = await readFile(b.store.path(b.record.id), 'utf8'); assert.ok(!saved.includes(secret)); assert.ok(!saved.includes('requestHeaders'));
  assert.match(saved, /ZC_NATIVE_FILE_READ_OK/); assert.match(saved, /nativeSessionId/);
});
test('resuming restores visible history and takes an exclusive session lock', async t => {
  const { b, cwd, config } = await backend(t); const { id: localId } = await b.start(); await b.send('first');
  const other = new NativeStreamBackend({ cwd, config, storeHome: join(cwd, 'state'), emit: () => {} });
  t.after(() => other.dispose()); await assert.rejects(other.start(localId), /locked/);
  await b.dispose(); const events = [];
  const resumed = new NativeStreamBackend({ cwd, config, storeHome: join(cwd, 'state'), emit: e => events.push(e) }); t.after(() => resumed.dispose());
  await resumed.start(localId); assert.ok(events.some(e => e.role === 'assistant' && e.text === 'ZC_NATIVE_FILE_READ_OK'));
  await resumed.send('second'); assert.equal(resumed.record.nativeSessionId, 'sess_fixture-stream');
});
test('session records cannot cross workspaces, runtimes, or policy versions', async t => {
  const { b } = await backend(t); await b.start(); await b.send('hi');
  const s = JSON.parse(await readFile(b.store.path(b.record.id), 'utf8'));
  for (const change of [{ cwd: '/other' }, { runtimeIdentity: 'different' }, { policy: 'unsafe' }, { nativeSessionId: '../../escape' }]) {
    await writeFile(b.store.path(b.record.id), JSON.stringify({ ...s, ...change })); await assert.rejects(b.store.load(b.record.id), /incompatible/);
  }
});
test('model change is explicit, transient to stream session, and not advertised as verified', async t => {
  const { b, events } = await backend(t); await b.start(); await b.setModel('fixture/other');
  assert.equal(b.model, 'fixture/other'); assert.ok(events.some(e => e.text?.includes('validated by ZCode')));
  await assert.rejects(b.setMode('ask'), /cannot supply/); await assert.rejects(b.compact(), /not integrated/);
});
test('failed turns retain an upstream session ID and do not retry automatically', async t => {
  const { b } = await backend(t); await b.start(); await assert.rejects(b.send('auth-error'), /project_token_login_failed/);
  assert.equal(b.record.status, 'failed'); assert.equal(b.record.nativeSessionId, 'sess_fixture-stream');
  assert.equal(b.display.entries.filter(e => e.role === 'user').length, 1);
});
test('stream footer and model help disclose the policy without erasing a draft', async t => {
  const app = new TerminalApp({ cwd: process.cwd(), config: validateConfig({ backend: 'native-stream', mode: 'guarded' }), output: new PassThrough() });
  app.schedule = () => {}; app.backend = { needsModel: true }; app.editor.set('keep this draft'); t.after(() => clearTimeout(app.toastTimer));
  await app.command('/model'); assert.equal(app.editor.text, 'keep this draft');
  await app.command('/mode ask'); assert.equal(app.config.mode, 'guarded');
  for (const [columns, rows] of [[80, 24], [120, 32], [40, 14]]) {
    const frame = renderFrame(app, columns, rows, false); assert.ok(frame.lines.every(line => width(line) <= columns - 1));
  }
  assert.ok(renderFrame(app, 120, 32, false).lines.some(line => clean(line).includes('guarded, no approvals')));
});
test('installed-style CLI execution uses stream backend without raw diagnostic output', async t => {
  const cwd = await dir(t), home = join(cwd, 'state'); await import('../src/util.mjs').then(m => m.writeJson(join(home, 'config.json'), { runtime }));
  const p = await runProcess(process.execPath, [bin, 'exec', 'hello', '--backend', 'native-stream', '--mode', 'guarded', '--model', model, '--trust'], { cwd, env: { ...process.env, ZC_HOME: home }, timeout: 8000 });
  assert.equal(p.code, 0, p.output); assert.match(p.output, /ZC_NATIVE_FILE_READ_OK/); assert.ok(!p.output.includes(secret)); assert.ok(!p.output.includes('requestHeaders'));
});
