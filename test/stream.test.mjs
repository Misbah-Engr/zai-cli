import test from 'node:test';
import assert from 'node:assert/strict';
import { sseData, collectCompletion } from '../src/sse.mjs';
const frame = data => 'data: ' + JSON.stringify(data) + '\r\n\r\n';
async function* bytes(text, chunkSize = 1) { const buffer = Buffer.from(text); for (let i = 0; i < buffer.length; i += chunkSize) yield buffer.subarray(i, i + chunkSize); }

test('SSE parses split UTF-8, CRLF, and multiline data', async () => {
  const data = [];
  for await (const value of sseData(bytes(': comment\r\ndata: 你好\r\ndata: world\r\n\r\n'))) data.push(value);
  assert.deepEqual(data, ['你好\nworld']);
});
test('completion joins fragmented tool arguments and reasoning correctly', async () => {
  const stream = frame({ choices: [{ delta: { reasoning_content: 'Consider ', tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"pa' } }] } }] }) +
    frame({ choices: [{ delta: { reasoning_content: 'the source.', tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }] }, finish_reason: 'tool_calls' }] }) +
    'data: [DONE]\r\n\r\n';
  const result = await collectCompletion(bytes(stream, 3));
  assert.equal(result.reasoning_content, 'Consider the source.'); assert.equal(result.tool_calls[0].function.arguments, '{"path":"a.ts"}');
});
test('incomplete streams cannot produce executable tool calls', async () => {
  const stream = frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'shell', arguments: '{"command":"echo x"}' } }] } }] });
  await assert.rejects(collectCompletion(bytes(stream)), /without a complete answer/);
});
test('length-limited and malformed tool arguments are rejected', async () => {
  await assert.rejects(collectCompletion(bytes(frame({ choices: [{ delta: { content: 'partial' }, finish_reason: 'length' }] }) + 'data: [DONE]\n\n')), /without a complete answer/);
  const invalid = frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'x', function: { name: 'shell', arguments: '{' } }] }, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n';
  await assert.rejects(collectCompletion(bytes(invalid)), /incomplete or invalid/);
});
test('provider event byte limits apply before parsing JSON', async () => {
  await assert.rejects(async () => { for await (const data of sseData(bytes('data: ' + 'x'.repeat(100) + '\n\n'), { maxEventBytes: 32 })) void data; }, /byte limit/);
});
test('duplicate tool IDs are rejected', async () => {
  const stream = frame({ choices: [{ delta: { tool_calls: [0,1].map(index => ({ index, id: 'duplicate', function: { name: 'read_file', arguments: '{}' } })) }, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n';
  await assert.rejects(collectCompletion(bytes(stream)), /duplicate/);
});
