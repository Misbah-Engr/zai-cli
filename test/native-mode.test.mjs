import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeBackend } from '../src/backends/native.mjs';
import { NATIVE_MODES, snapshotPermissionMode, fullAccessConfirmation } from '../src/backends/native-mode.mjs';
import { TerminalApp } from '../src/ui/app.mjs';
import { renderFrame, painter } from '../src/ui/render.mjs';
import { WorkspaceState } from '../src/state.mjs';
import { validateConfig, saveConfig, loadConfig } from '../src/config.mjs';
import { clean, width } from '../src/util.mjs';

const fixture = fileURLToPath(new URL('./fixtures/native-runtime.mjs', import.meta.url));
function make(t, { ask = async () => true, mode = 'ask' } = {}) {
  const events = [], requests = [];
  const config = validateConfig({ runtime: { command: process.execPath, args: [fixture] }, mode });
  const b = new NativeBackend({ cwd: process.cwd(), config, emit: e => events.push(e),
    ask: async (...args) => { requests.push(args[0]); return ask(...args); } });
  t.after(() => b.dispose());
  return { b, config, events, requests };
}
function app(t, config = {}) {
  const a = new TerminalApp({ cwd: process.cwd(), config: validateConfig(config), output: new PassThrough() });
  a.schedule = () => {}; t.after(() => clearTimeout(a.toastTimer)); return a;
}
const snapshot = mode => ({ session: { sessionId: 's', mode }, settings: { mode: { current: mode } } });

test('mode table is immutable and asks for real upstream modes', () => {
  assert.deepEqual(NATIVE_MODES, { ask: 'guarded', yolo: 'yolo', 'read-only': 'plan' });
  assert.ok(Object.isFrozen(NATIVE_MODES));
});
test('mode parsing rejects wrong-session, missing, unknown, and conflicting state', () => {
  assert.equal(snapshotPermissionMode(snapshot('yolo'), 's'), 'yolo');
  for (const s of [null, {}, snapshot('unknown'), { ...snapshot('yolo'), settings: { permission: { mode: 'yolo' }, mode: { current: 'guarded' } } }]) {
    assert.throws(() => snapshotPermissionMode(s, 's'));
  }
  assert.throws(() => snapshotPermissionMode(snapshot('guarded'), 'other'));
});
test('full access confirmation states real scope, operating-system access, and remaining runtime gates', () => {
  const p = fullAccessConfirmation('/workspace');
  assert.equal(p.allowLabel, 'Enable YOLO');
  assert.match(p.detail, /edit or delete files/); assert.match(p.detail, /not in an OS sandbox/);
  assert.match(p.input, /NOT confined/); assert.match(p.input, /fresh consent/);
  assert.match(p.input, /Runtime-required confirmations/); assert.match(p.input, /No prompt is submitted/);
});
test('native startup confirms actual guarded state without granting full access', async t => {
  const { b, requests, events } = make(t); await b.start();
  assert.equal(b.mode, 'ask'); assert.equal(b.runtimeMode, 'guarded'); assert.equal(b.modeUnknown, false);
  assert.equal(requests.length, 0);
  assert.ok(events.some(e => e.type === 'mode' && e.mode === 'ask'));
});
test('confirmed native YOLO sets upstream state, labels it, and keeps global config unchanged', async t => {
  const f = make(t); const original = JSON.stringify(f.config); await f.b.start();
  const result = await f.b.setMode('yolo');
  assert.deepEqual(result, { changed: true, mode: 'yolo', runtimeMode: 'yolo' });
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].allowLabel, 'Enable YOLO');
  assert.equal((await f.b.rpc.request('session/read', { sessionId: f.b.session.sessionId })).session.mode, 'yolo');
  assert.equal(JSON.stringify(f.config), original);
  assert.ok(f.events.some(e => e.type === 'mode' && e.mode === 'yolo'));
  assert.ok(!f.events.some(e => e.role === 'user' || e.type === 'tool'));
});
test('declining full access sends no mode mutation and leaves current policy unchanged', async t => {
  const f = make(t, { ask: async () => false }); await f.b.start();
  const send = f.b.rpc.request.bind(f.b.rpc), calls = [];
  f.b.rpc.request = (method, ...args) => { calls.push(method); return send(method, ...args); };
  const result = await f.b.setMode('yolo');
  assert.equal(result.declined, true); assert.equal(f.b.mode, 'ask');
  assert.deepEqual(calls, ['session/read']);
});
test('Escape/abort while confirming full access sends no mode mutation', async t => {
  const controller = new AbortController();
  const f = make(t, { ask: async () => { controller.abort(); return true; } }); await f.b.start();
  const result = await f.b.setMode('yolo', controller.signal);
  assert.equal(result.declined, true); assert.equal(f.b.runtimeMode, 'guarded');
});
test('pre-aborted mode changes make no request', async t => {
  const f = make(t); await f.b.start(); const c = new AbortController(); c.abort();
  f.b.rpc.request = async () => { throw new Error('must not be called'); };
  await assert.rejects(f.b.setMode('yolo', c.signal), { name: 'AbortError' });
});
test('ask returns to guarded policy without another full-access dialog', async t => {
  const f = make(t); await f.b.start(); await f.b.setMode('yolo');
  const result = await f.b.setMode('ask'); assert.equal(result.runtimeMode, 'guarded');
  assert.equal(f.b.mode, 'ask'); assert.equal(f.requests.length, 1);
});
test('repeating an acknowledged YOLO command neither mutates nor repeats consent', async t => {
  const f = make(t); await f.b.start(); await f.b.setMode('yolo');
  assert.equal((await f.b.setMode('yolo')).changed, false); assert.equal(f.requests.length, 1);
});
test('runtime-mandatory permission requests still reach the user in YOLO', async t => {
  const f = make(t); await f.b.start(); await f.b.setMode('yolo'); await f.b.send('hello');
  assert.equal(f.requests.length, 2); assert.match(f.requests[1].title, /Allow Read/);
});
test('unknown capabilities and auth requests are not granted by full-access consent', async t => {
  const f = make(t); await f.b.start(); await f.b.setMode('yolo');
  await assert.rejects(f.b.interaction('unknown/request', {}), { code: -32601 });
  assert.equal((await f.b.interaction('interaction/requestProviderRuntimeHeaders', {})).headersApplied, false);
  assert.equal((await f.b.interaction('interaction/requestOfficialMcpAuthHeaders', {})).ok, false);
  assert.equal(f.requests.length, 1);
});
test('resuming an upstream YOLO session resets to guarded before further input', async t => {
  const f = make(t); await f.b.start('native-fixture-session');
  assert.equal(f.b.runtimeMode, 'guarded'); assert.equal(f.b.mode, 'ask'); assert.equal(f.requests.length, 0);
  await f.b.setMode('yolo'); assert.equal(f.requests.length, 1);
});
test('read-only launch cannot escalate or remove the creation-time tool allowlist', async t => {
  const f = make(t, { mode: 'read-only' }); await f.b.start();
  for (const mode of ['yolo', 'ask']) await assert.rejects(f.b.setMode(mode), /session creation/);
  assert.equal((await f.b.setMode('read-only')).changed, false);
  assert.equal(f.b.runtimeMode, 'plan'); assert.equal(f.requests.length, 0);
});
test('entering native read-only from an unrestricted session requires a new launch', async t => {
  const f = make(t); await f.b.start(); await assert.rejects(f.b.setMode('read-only'), /session creation/);
});
test('active turns and concurrent changes cannot race a mode mutation', async t => {
  let finish;
  const f = make(t, { ask: () => new Promise(resolve => { finish = resolve; }) }); await f.b.start();
  f.b.active = { finish() {} }; await assert.rejects(f.b.setMode('yolo'), /active turn/); f.b.active = undefined;
  const pending = f.b.setMode('yolo');
  while (!finish) await new Promise(resolve => setTimeout(resolve, 1));
  await assert.rejects(f.b.setMode('ask'), /pending mode/);
  await assert.rejects(f.b.send('not sent'), /mode change is pending/);
  finish(false); await pending;
});
test('runtime busy-state rejection preserves permissions', async t => {
  const f = make(t); await f.b.start(); const rpc = f.b.rpc.request.bind(f.b.rpc);
  f.b.rpc.request = async (...args) => { const s = await rpc(...args); if (args[0] === 'session/read') s.session.status = 'running'; return s; };
  await assert.rejects(f.b.setMode('yolo'), /Stop the runtime turn/); assert.equal(f.requests.length, 0);
});
test('failed mutation becomes unconfirmed and blocks input until explicit ask recovery', async t => {
  const f = make(t); await f.b.start(); const rpc = f.b.rpc.request.bind(f.b.rpc);
  f.b.rpc.request = async (method, params) => {
    if (method === 'session/setMode' && params.mode === 'yolo') { await rpc(method, params); throw new Error('lost answer'); }
    return rpc(method, params);
  };
  await assert.rejects(f.b.setMode('yolo'), /may have applied/);
  assert.equal(f.b.modeUnknown, true); assert.equal(f.b.mode, 'unknown');
  await assert.rejects(f.b.send('not sent'), /unconfirmed/);
  await assert.rejects(f.b.compact(), /Confirm the runtime mode/);
  assert.equal((await f.b.setMode('ask')).runtimeMode, 'guarded');
  assert.equal(f.b.modeUnknown, false);
});
test('mismatched runtime acknowledgment cannot show YOLO as enabled', async t => {
  const f = make(t); await f.b.start(); const rpc = f.b.rpc.request.bind(f.b.rpc);
  f.b.rpc.request = async (method, params) => method === 'session/setMode' ? rpc('session/read', params) : rpc(method, params);
  await assert.rejects(f.b.setMode('yolo'), /not requested yolo/);
  assert.equal(f.b.mode, 'unknown'); assert.ok(!f.events.some(e => e.type === 'mode' && e.mode === 'yolo'));
});
test('mode command can validate an acknowledgment through session/read', async t => {
  const f = make(t); await f.b.start(); const rpc = f.b.rpc.request.bind(f.b.rpc);
  f.b.rpc.request = async (method, params) => { const result = await rpc(method, params); return method === 'session/setMode' ? {} : result; };
  assert.equal((await f.b.setMode('yolo')).runtimeMode, 'yolo');
});
test('a different session cannot be substituted during the consent dialog', async t => {
  const f = make(t, { ask: async () => { f.b.session = { ...f.b.session, sessionId: 'other' }; return true; } }); await f.b.start();
  await assert.rejects(f.b.setMode('yolo'), { name: 'AbortError' });
  assert.equal(f.b.runtimeMode, 'guarded');
});
test('unsupported values and prototype names do not dispatch a mode mutation', async t => {
  const f = make(t); await f.b.start();
  for (const value of ['auto', 'full', 'constructor', '__proto__', 'yolo\n/new']) await assert.rejects(f.b.setMode(value), /Native modes/);
  assert.equal(f.requests.length, 0);
});
test('UI routes native /mode yolo to the backend without changing saved config', async t => {
  const a = app(t), calls = [], original = JSON.stringify(a.config);
  a.backend = { setMode: async (value, signal) => { calls.push([value, signal instanceof AbortSignal]); return { changed: true, mode: value }; } };
  await a.command('/mode yolo'); assert.deepEqual(calls, [['yolo', true]]);
  assert.equal(JSON.stringify(a.config), original);
  assert.ok(a.state.entries.some(e => e.text?.includes('FULL ACCESS enabled')));
});
test('UI does not announce enabled mode after a denied consent', async t => {
  const a = app(t); a.backend = { setMode: async () => ({ changed: false, declined: true }) };
  await a.command('/mode yolo'); assert.match(a.toast, /not enabled/);
  assert.ok(!a.state.entries.some(e => e.text?.includes('FULL ACCESS enabled')));
});
test('native mode help reports acknowledged state without clearing an unsent draft', async t => {
  const a = app(t); a.editor.set('keep this task'); a.backend = { mode: 'yolo', runtimeMode: 'yolo' };
  await a.command('/mode'); assert.equal(a.editor.text, 'keep this task');
  assert.ok(a.state.entries.some(e => e.text?.includes('Current mode: yolo')));
});
test('direct API and native stream cannot enable YOLO through the new UI command', async t => {
  for (const backend of ['zai', 'native-stream']) {
    const a = app(t, { backend }); let calls = 0; a.backend = { setMode: async () => { calls++; } };
    await a.command('/mode yolo'); assert.equal(calls, 0); assert.equal(a.config.mode, 'ask');
  }
});
test('YOLO cannot be saved as a global launch default', () => {
  assert.throws(() => validateConfig({ mode: 'yolo' }), /mode must/);
});
test('saving theme while native YOLO is active does not persist full access', async t => {
  const root = await mkdtemp(join(tmpdir(), 'zc-mode-config-')), old = process.env.ZC_HOME;
  process.env.ZC_HOME = root;
  t.after(async () => { if (old === undefined) delete process.env.ZC_HOME; else process.env.ZC_HOME = old; await rm(root, { recursive: true, force: true }); });
  const a = app(t); a.state.apply({ type: 'mode', mode: 'yolo', runtimeMode: 'yolo' });
  await a.command('/theme light');
  assert.equal((await loadConfig()).mode, 'ask'); assert.equal((await loadConfig()).theme, 'light');
});
test('full-access dialog defaults to deny and pasted slash text cannot enable it', async t => {
  const a = app(t), pending = a.ask(fullAccessConfirmation('/workspace'));
  a.handleKey({ text: '/mode yolo\nyes\n' }); assert.equal(a.permission.allow, false);
  const frame = renderFrame(a, 100, 30, false);
  assert.ok(frame.lines.some(line => line.includes('[ Deny ]   Enable YOLO')));
  a.handleKey({ key: 'enter' }); assert.equal(await pending, false);
});
test('explicit right-arrow and Enter confirms the full-access dialog once', async t => {
  const a = app(t), pending = a.ask(fullAccessConfirmation('/workspace'));
  a.handleKey({ key: 'right' }); a.handleKey({ key: 'enter' }); assert.equal(await pending, true); assert.equal(a.permission, null);
});
test('full-access footer is explicit in color and monochrome, not hidden behind a config default', async t => {
  for (const theme of ['dark', 'light', 'mono']) {
    const a = app(t, { theme }); a.state.apply({ type: 'mode', mode: 'yolo', runtimeMode: 'yolo' });
    const frame = renderFrame(a, 120, 30, theme !== 'mono');
    assert.ok(frame.lines.some(line => clean(line).includes('YOLO / FULL ACCESS')));
    assert.equal(a.config.mode, 'ask');
  }
});
test('unknown mode is visible and reset clears stale full-access presentation', async t => {
  const a = app(t); a.state.apply({ type: 'mode', mode: 'unknown', runtimeMode: 'unknown' });
  assert.ok(renderFrame(a, 120, 30, false).lines.some(line => line.includes('MODE UNCONFIRMED')));
  a.state.apply({ type: 'reset' }); assert.equal(a.state.mode, ''); assert.equal(a.state.runtimeMode, '');
});
test('full-access renderer remains bounded at supported terminal sizes', async t => {
  const a = app(t); a.state.apply({ type: 'mode', mode: 'yolo', runtimeMode: 'yolo' });
  for (const [cols, rows] of [[120,32], [80,24], [60,14], [36,14]]) {
    const frame = renderFrame(a, cols, rows, true); assert.equal(frame.lines.length, rows);
    for (const line of frame.lines) assert.ok(width(line) <= cols - 1);
  }
});
test('light theme secondary controls and code no longer use the pale palette', () => {
  assert.match(painter('light')('controls', 'faint'), /38;2;85;99;119/);
  assert.match(painter('light')('code', 'code'), /38;2;40;53;73/);
});
test('opening a new approval clears a stale denial toast', async t => {
  const a = app(t); a.notify('Full access was not enabled.');
  const pending = a.ask(fullAccessConfirmation('/workspace'));
  assert.equal(a.toast, '');
  a.handleKey({ key: 'escape' }); assert.equal(await pending, false);
});

test('live app permission settings take precedence over a lagging session projection', () => {
  const value = { session: { sessionId: 's', mode: 'guarded' }, settings: { permission: { mode: 'yolo' }, mode: { current: 'yolo' } } };
  assert.equal(snapshotPermissionMode(value, 's'), 'yolo');
  delete value.settings.permission;
  assert.equal(snapshotPermissionMode(value, 's'), 'yolo');
});
