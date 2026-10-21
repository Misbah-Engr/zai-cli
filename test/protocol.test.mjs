import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { ProtocolClient } from '../src/protocol.mjs';
import { delay } from '../src/util.mjs';

function transport(t, options = {}) {
  const input = new PassThrough(), output = new PassThrough(), sent = [];
  output.on('data', chunk => sent.push(JSON.parse(chunk.toString())));
  const rpc = new ProtocolClient(input, output, { timeoutMs: 100, ...options });
  t.after(() => { rpc.close(); input.destroy(); output.destroy(); });
  return { rpc, input, output, sent };
}
test('RPC correlates out-of-order answers by ID', async t => {
  const { rpc, input, sent } = transport(t);
  const first = rpc.request('one'), second = rpc.request('two');
  input.write(JSON.stringify({ id: sent[1].id, result: 2 }) + '\n');
  input.write(JSON.stringify({ id: sent[0].id, result: 1 }) + '\n');
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
});
test('RPC accepts UTF-8 split inside a multibyte character', async t => {
  const { rpc, input, sent } = transport(t); const pending = rpc.request('read');
  const frame = Buffer.from(JSON.stringify({ id: sent[0].id, result: '你好' }) + '\n');
  for (const byte of frame) input.write(Buffer.from([byte]));
  assert.equal(await pending, '你好');
});
test('RPC rejects stdout pollution and fails pending calls', async t => {
  const { rpc, input } = transport(t); const pending = rpc.request('read');
  input.write('debug logging belongs on stderr\n'); await assert.rejects(pending, /non-JSON/);
  assert.equal(rpc.closed, true);
});
test('RPC does not replay timed-out or aborted requests', async t => {
  const { rpc, sent } = transport(t); await assert.rejects(rpc.request('send', {}, { timeoutMs: 10 }), /not replayed/);
  const controller = new AbortController(); const pending = rpc.request('second', {}, { signal: controller.signal }); controller.abort();
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(sent.length, 2);
});
test('reverse requests run while an ordinary RPC is pending', async t => {
  let approvals = 0;
  const { rpc, input, sent } = transport(t, { onRequest: async () => { approvals++; return { decision: 'deny' }; } });
  const pending = rpc.request('session/send');
  input.write(JSON.stringify({ id: 'permission', method: 'interaction/requestPermission', params: {} }) + '\n');
  await delay(5); assert.equal(approvals, 1); assert.equal(sent[1].result.decision, 'deny');
  input.write(JSON.stringify({ id: sent[0].id, result: { accepted: true } }) + '\n'); await pending;
});
test('duplicate reverse requests never open a second approval', async t => {
  let calls = 0;
  const { input, sent } = transport(t, { onRequest: async () => { calls++; await delay(5); return { decision: 'allow' }; } });
  const request = JSON.stringify({ id: 'x', method: 'approve', params: { action: 'same' } }) + '\n';
  input.write(request + request); await delay(15); input.write(request); await delay(5);
  assert.equal(calls, 1); assert.equal(sent.length, 2); assert.deepEqual(sent[0], sent[1]);
});
test('reverse ID reuse with changed arguments fails closed', async t => {
  const { rpc, input } = transport(t, { onRequest: async () => ({ decision: 'allow' }) });
  input.write(JSON.stringify({ id: 'x', method: 'approve', params: { action: 'safe' } }) + '\n'); await delay(5);
  input.write(JSON.stringify({ id: 'x', method: 'approve', params: { action: 'different' } }) + '\n');
  assert.equal(rpc.closed, true);
});
test('invalid envelope and oversized frames are rejected', async t => {
  const { rpc, input } = transport(t, { maxFrameBytes: 100 });
  const pending = rpc.request('x'); input.write('x'.repeat(101)); await assert.rejects(pending, /byte limit/);
});
test('EOF fails an unfinished RPC instead of leaving it hanging', async t => {
  const { rpc, input } = transport(t); const pending = rpc.request('x'); input.end(); await assert.rejects(pending, /closed its connection/);
});
