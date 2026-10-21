import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeTurn } from '../src/backends/native-turn.mjs';
import { TerminalApp } from '../src/ui/app.mjs';
import { validateConfig } from '../src/config.mjs';
import { PassThrough } from 'node:stream';
const event = (type, seq, payload = {}, extra = {}) => ({ type, seq, payload, sessionId: 's', turnId: 't', ...extra });
const snapshot = (active, status = active ? 'running' : 'idle') => ({ session: { sessionId: 's', status }, runtime: { mainActive: active }, projection: {} });
function fixture(t, read = snapshot(true), events = []) {
  const calls = [], emitted = [], completed = [];
  const rpc = { async request(method, args) { calls.push([method, args]); if (method === 'session/read') { if (read instanceof Error) throw read; return read; } return { events: events.filter(e => e.seq > args.afterSeq).slice(0, args.limit) }; } };
  const monitor = new NativeTurn({ inputId: 'input', text: 'Exact user task', afterSeq: 10, sessionId: 's', rpc, emit: e => emitted.push(e), complete: e => { completed.push(e); monitor.close(); }, intervalMs: 60000 });
  t.after(() => monitor.close()); return { monitor, calls, emitted, completed };
}
test('legacy start without input IDs binds only the exact root prompt', t => {
  const { monitor: m } = fixture(t);
  assert.equal(m.observe(event('turn.started', 11, { input: 'Different task' })), false);
  assert.equal(m.observe(event('turn.started', 12, { input: 'Exact user task', backgroundSource: 'subagent' })), false);
  assert.equal(m.observe(event('turn.started', 13, { input: 'Exact user task' })), true);
  assert.equal(m.matches(event('turn.completed', 14, { resultType: 'success' })), true);
});
test('explicit query correlation works and mismatched IDs never attach', t => {
  const { monitor: m } = fixture(t);
  assert.equal(m.observe(event('turn.started', 11, { input: 'Exact user task', inputId: 'wrong' })), false);
  assert.equal(m.observe(event('turn.started', 12, { queryId: 'input' })), true);
  assert.equal(m.matches(event('turn.completed', 13, { queryId: 'other' })), false);
  assert.equal(m.matches(event('turn.completed', 14, {}, { turnId: 'other' })), false);
  assert.equal(m.matches(event('turn.completed', 14, {}, { sessionId: 'elsewhere' })), false);
});
test('repeated quiet periods do not stop or replay a healthy active task', async t => {
  const f = fixture(t); f.monitor.observe(event('turn.started', 11, { inputId: 'input' }));
  for (let i = 0; i < 12; i++) await f.monitor.probe();
  assert.equal(f.monitor.closed, false); assert.equal(f.completed.length, 0);
  assert.ok(f.calls.every(([method]) => ['session/read', 'session/events'].includes(method)));
  assert.equal(f.emitted.at(-1).phase, 'working');
});
test('quiet permission waits stay open and do not issue health or stop requests', async t => {
  const f = fixture(t); f.monitor.waitingForApproval = 1;
  await f.monitor.probe(); assert.equal(f.calls.length, 0); assert.equal(f.emitted.at(-1).phase, 'waiting');
});
test('health failure remains uncertain rather than declaring a stopped task', async t => {
  const f = fixture(t, new Error('timeout')); await f.monitor.probe(); await f.monitor.probe();
  assert.equal(f.emitted.at(-1).phase, 'uncertain'); assert.equal(f.monitor.failures, 2);
  assert.equal(f.monitor.closed, false); assert.equal(f.completed.length, 0);
  assert.ok(f.calls.every(([method]) => method === 'session/read'));
});
test('missing completion is recovered by paginated events after 1,000 records', async t => {
  const events = [event('turn.started', 11, { input: 'Exact user task' }), ...Array.from({ length: 2200 }, (_, i) => event('model.streaming', i + 12)), event('turn.completed', 2212, { resultType: 'success' })];
  const f = fixture(t, snapshot(false), events); await f.monitor.probe();
  assert.equal(f.completed.length, 1); assert.equal(f.completed[0].seq, 2212);
  assert.equal(f.calls.filter(([method]) => method === 'session/events').length, 3);
  assert.ok(!f.calls.some(([method]) => method === 'session/stop'));
});
test('idle without a matching completion requests inspection without stopping', async t => {
  const f = fixture(t, snapshot(false)); let error;
  f.monitor.onUnconfirmed = e => { error = e; f.monitor.close(); }; await f.monitor.probe();
  assert.match(error.message, /no matching completion/); assert.ok(!f.calls.some(([m]) => m === 'session/stop'));
});
test('unavailable event history does not mistake an idle snapshot for task failure', async t => {
  const f = fixture(t, snapshot(false)); const request = f.monitor.rpc.request;
  f.monitor.rpc.request = (method, args) => method === 'session/events' ? Promise.reject(new Error('not supported')) : request(method, args);
  let unconfirmed = false; f.monitor.onUnconfirmed = () => { unconfirmed = true; };
  await f.monitor.probe(); assert.equal(unconfirmed, false); assert.equal(f.monitor.closed, false);
});
test('UI preserves uncertain state and does not label a possibly active tool cancelled', async () => {
  const app = new TerminalApp({ cwd: '/tmp/fixture', config: validateConfig({}), output: new PassThrough(), demo: true }); app.schedule = () => {};
  app.state.apply({ type: 'tool', id: 'task', name: 'Bash', status: 'running' });
  await assert.rejects(app.work(async () => { app.state.apply({ type: 'status', phase: 'uncertain' }); throw new Error('inspection required'); }));
  assert.equal(app.state.phase, 'uncertain'); assert.equal(app.state.entries.find(e => e.id === 'task').status, 'running');
});
