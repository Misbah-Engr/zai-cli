import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { NativeBackend } from '../src/backends/native.mjs';
import { NATIVE_PREFERENCES, nativeModelCatalog, parseNativeModel, formatNativeModel, snapshotModel, runtimePreferences } from '../src/backends/native-contract.mjs';
import { validateConfig } from '../src/config.mjs';
import { TerminalApp } from '../src/ui/app.mjs';
import { renderFrame } from '../src/ui/render.mjs';
import { clean, width } from '../src/util.mjs';
const fixture = fileURLToPath(new URL('./fixtures/native-startup.mjs', import.meta.url));
const base = { ref: { providerId: 'fixture', modelId: 'model' }, label: 'Fixture model' };
const snapshot = available => ({ settings: { model: { available } } });
function make(t) {
  const events = []; let approvals = 0;
  const native = new NativeBackend({ cwd: process.cwd(), config: validateConfig({ mode: 'read-only', runtime: { command: process.execPath, args: [fixture] } }), emit: e => events.push(e), ask: async () => { approvals++; return true; } });
  t.after(() => native.dispose()); return { native, events, approvals: () => approvals };
}
test('startup preference and MCP requests complete before the session response without approvals', async t => {
  const f = make(t), result = await f.native.start();
  assert.equal(result.needsModel, true); assert.equal(result.models.length, 3);
  assert.equal(f.approvals(), 0); assert.equal(f.native.needsModel, true);
  assert.ok(!f.events.some(e => e.text?.includes('Unsupported native interaction')));
  assert.ok(f.events.some(e => e.type === 'session' && e.model === 'No model selected'));
});
test('missing model does not send a prompt or write a fictional user turn', async t => {
  const f = make(t); await f.native.start();
  await assert.rejects(f.native.send('do not send this'), /prompt was not sent/);
  assert.equal((await f.native.rpc.request('fixture/stats')).sent, 0);
  assert.ok(!f.events.some(e => e.role === 'user'));
});
test('catalog selection round-trips exact model and reasoning identifiers', async t => {
  const f = make(t); await f.native.start();
  await f.native.setModel('fixture/model-b$high');
  assert.equal(f.native.needsModel, false); assert.equal(formatNativeModel(f.native.model), 'fixture/model-b$high');
  assert.equal((await f.native.rpc.request('fixture/stats')).selected, 1);
});
test('unknown and unavailable models are rejected before selection RPC', async t => {
  const f = make(t); await f.native.start();
  await assert.rejects(f.native.setModel('made-up/provider'), /not in the runtime catalog/);
  await assert.rejects(f.native.setModel('fixture/locked'), /unavailable/);
  assert.equal((await f.native.rpc.request('fixture/stats')).selected, 0);
});
test('runtime preferences are conservative, copied, and validate scope and session', () => {
  const p = { sessionId: 's', scope: 'runtime-materialization' };
  const a = runtimePreferences(p, 's'); a.memoryEnabled = true;
  assert.deepEqual(runtimePreferences({ ...p, scope: 'user-execution' }, 's'), NATIVE_PREFERENCES);
  for (const bad of [{}, null, { ...p, scope: 'made-up' }, { ...p, allowAll: true }, { ...p, sessionId: 'other' }]) assert.throws(() => runtimePreferences(bad, 's'), { code: -32602 });
});
test('official MCP unavailable replies are schema-shaped and emit only one notice', async t => {
  const f = make(t);
  for (let i = 0; i < 3; i++) assert.deepEqual(await f.native.interaction('interaction/requestOfficialMcpAuthHeaders', { arbitrarySecret: 'never-print-this' }), { ok: false, reason: 'official_auth_unavailable' });
  assert.equal(f.events.length, 1); assert.ok(!JSON.stringify(f.events).includes('never-print-this')); assert.equal(f.approvals(), 0);
});
test('account-model auth remains explicitly unavailable, with no fake headers', async t => {
  const f = make(t);
  const result = await f.native.interaction('interaction/requestProviderRuntimeHeaders', {});
  assert.equal(result.headersApplied, false); assert.equal(result.requestAuth, undefined);
  assert.match(result.errorMessage, /not implement/); assert.equal(f.approvals(), 0);
});
test('unknown runtime interactions continue to fail closed and deduplicate notices', async t => {
  const f = make(t);
  for (let i = 0; i < 2; i++) await assert.rejects(f.native.interaction('unknown/capability', {}), { code: -32601 });
  assert.equal(f.events.length, 1); assert.equal(f.approvals(), 0);
});
test('model catalog retains disabled status and only offers advertised reasoning levels', () => {
  const options = nativeModelCatalog(snapshot([{ ...base, reasoning: { defaultLevel: 'fabricated', levels: [{ value: 'high', label: 'High' }, { value: 'low', label: 'Low' }] }, disabledReason: '' }]));
  assert.deepEqual(options.map(x => x.value), ['fixture/model$high', 'fixture/model$low']);
  assert.ok(options.every(x => x.disabled));
});
test('conflicting duplicate model entries cannot enable an unavailable model', () => {
  const options = nativeModelCatalog(snapshot([{ ...base, disabledReason: 'not entitled' }, base]));
  assert.equal(options.length, 1); assert.equal(options[0].disabled, true);
});
test('model references reject ambiguous delimiters and control-character injection', () => {
  for (const value of ['', 'bare-model', 'x/y$high$low', 'x/y\n/quit', 'x/y$', 'x/y z']) assert.throws(() => parseNativeModel(value));
  assert.throws(() => formatNativeModel({ providerId: 'x/y', modelId: 'z' }));
  assert.deepEqual(parseNativeModel('fixture/nested/model$high'), { providerId: 'fixture', modelId: 'nested/model', options: { reasoningLevel: 'high' } });
});
test('model catalogs reject oversized and malformed metadata', () => {
  for (const entries of ['not-an-array', Array(513).fill(base), [null], [{ ...base, disabledReason: true }], [{ ...base, reasoning: { levels: Array(33).fill({ value: 'x', label: 'x' }) } }]]) assert.throws(() => nativeModelCatalog(snapshot(entries)));
});
test('current settings are authoritative and do not silently fall back to last-used model', () => {
  assert.equal(snapshotModel({ settings: { model: { lastUsed: base.ref } }, session: { model: base.ref } }), undefined);
  assert.deepEqual(snapshotModel({ session: { model: base.ref } }), base.ref);
});
function app(t) {
  const instance = new TerminalApp({ cwd: process.cwd(), config: validateConfig({}), output: new PassThrough() });
  instance.schedule = () => {}; t.after(() => clearTimeout(instance.toastTimer)); return instance;
}
test('model picker uses exact runtime refs without erasing the draft', async t => {
  const a = app(t), options = nativeModelCatalog(snapshot([base]));
  a.backend = { models: async () => options }; a.editor.set('keep my draft');
  await a.command('/model');
  assert.equal(a.palette.title, 'RUNTIME MODELS'); assert.equal(a.palette.items[0].command, '/model fixture/model');
  assert.equal(a.editor.text, 'keep my draft');
});
test('Enter on a disabled model does not dispatch a selection', t => {
  const a = app(t); let selections = 0; a.command = async () => { selections++; };
  a.openModels(nativeModelCatalog(snapshot([{ ...base, disabledReason: 'account locked' }])));
  a.handleKey({ key: 'enter' }); assert.equal(selections, 0); assert.ok(a.palette); assert.match(a.toast, /account locked/);
});
test('sending without a selected model preserves the prompt for explicit later submission', async t => {
  const a = app(t); let sends = 0;
  a.backend = { needsModel: true, modelOptions: nativeModelCatalog(snapshot([base])), send: async () => { sends++; } };
  await a.submit('read smoke.txt'); assert.equal(sends, 0); assert.equal(a.editor.text, 'read smoke.txt'); assert.equal(a.palette.title, 'RUNTIME MODELS');
});
test('model picker remains bounded at narrow and standard terminal sizes', t => {
  const a = app(t); a.openModels(nativeModelCatalog(snapshot([{ ...base, label: 'Very long label '.repeat(50), disabledReason: 'Unavailable' }])));
  for (const [cols, rows] of [[36, 14], [80, 24], [120, 32]]) {
    const frame = renderFrame(a, cols, rows, false);
    assert.equal(frame.lines.length, rows); assert.ok(frame.lines.every(line => width(line) <= cols - 1));
    assert.ok(frame.lines.some(line => clean(line).includes('RUNTIME MODELS')));
  }
});
