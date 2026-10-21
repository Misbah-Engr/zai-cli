import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { NativeBackend, parseNativeModel, snapshotMessages } from '../src/backends/native.mjs';
import { validateConfig } from '../src/config.mjs';
const runtime = fileURLToPath(new URL('./fixtures/native-runtime.mjs', import.meta.url));
function backend(t, mode = 'ask') {
  const events = []; let approvals = 0;
  const native = new NativeBackend({ cwd: process.cwd(), config: validateConfig({ runtime: { command: process.execPath, args: [runtime] }, mode }), emit: event => events.push(event), ask: async () => { approvals++; return true; } });
  t.after(() => native.dispose()); return { native, events, approvals: () => approvals };
}
test('native adapter creates, subscribes, handles approval, and completes a turn', async t => {
  const f = backend(t); await f.native.start(); await f.native.send('hello');
  assert.equal(f.approvals(), 1);
  assert.ok(f.events.some(e => e.type === 'message' && e.text === 'Native fixture says 你好.'));
  assert.equal(f.native.active, undefined);
  assert.equal((await f.native.sessions())[0].id, 'native-fixture-session');
});
test('native read-only mode denies additional permission requests', async t => {
  const f = backend(t, 'read-only'); await f.native.start(); await f.native.send('hello');
  assert.equal(f.approvals(), 0);
  assert.ok(f.events.some(e => e.type === 'tool' && e.output?.includes('deny')));
});
test('native resume applies guarded mode and uses explicit session IDs', async t => {
  const f = backend(t); await f.native.start('native-fixture-session');
  const snapshot = await f.native.rpc.request('session/setMode', { sessionId: 'native-fixture-session', mode: 'guarded' });
  assert.equal(snapshot.session.mode, 'guarded');
  await f.native.setModel('fixture/glm');
});
test('native model selection never invents a provider identifier', () => {
  assert.throws(() => parseNativeModel('glm-5.3'), /providerId/);
  assert.deepEqual(parseNativeModel('zai/glm$high'), { providerId: 'zai', modelId: 'glm', options: { reasoningLevel: 'high' } });
});
test('native snapshots hide model-only and reasoning parts', () => {
  const entries = snapshotMessages({ messages: [
    { info: { role: 'assistant', messageId: 'a' }, parts: [{ type: 'text', text: 'visible' }, { type: 'reasoning', text: 'private' }] },
    { info: { role: 'user', messageId: 'b', visibility: 'model-only' }, parts: [{ type: 'text', text: 'hidden' }] },
  ] });
  assert.equal(entries.length, 1); assert.equal(entries[0].text, 'visible');
});
