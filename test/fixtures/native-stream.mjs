// Synthetic runtime only. No network requests, credential files, or project tool execution.
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { STREAM_DENIED_TOOLS } from '../../src/backends/stream-contract.mjs';
if (process.argv.includes('--version')) {
  console.log('zcode-app-cli 3.15.3-37\nzcode-runtime 0.16.9'); process.exit(0);
}
const { values } = parseArgs({ args: process.argv.slice(2), options: {
  model: { type: 'string' }, mode: { type: 'string' }, disallowedTools: { type: 'string' },
  'output-format': { type: 'string' }, resume: { type: 'string' }, prompt: { type: 'string' },
} });
if (values.mode !== 'guarded' || values.disallowedTools !== STREAM_DENIED_TOOLS.join(',') || values['output-format'] !== 'stream-json') process.exit(9);
const prompt = values.prompt, sessionId = values.resume || 'sess_fixture-stream';
const turnId = 'turn_' + randomUUID(), assistantMessageId = 'msg_' + randomUUID(); let seq = 0;
const write = object => process.stdout.write(JSON.stringify(object) + '\n');
const event = (type, payload, extra = {}) => write({ type, eventId: randomUUID(), seq: ++seq, sessionId, turnId, timestamp: Date.now(), payload, ...extra });
const secret = 'SHOULD_NOT_APPEAR_IN_DISPLAY_OR_STATE_12345';
console.error('Internal credential diagnostic: ' + secret);
if (prompt === 'bad-json') { console.log('not-json ' + secret); process.exit(1); }
event('session.titleUpdated', { title: 'Fixture stream' });
event('turn.started', { input: prompt });
event('session.updated', { type: 'model_request_completed', requestHeaders: { Authorization: 'Bearer ' + secret }, stack: secret });
if (prompt === 'auth-error') {
  event('turn.failed', { error: { message: 'project_token_login_failed', stack: secret } }); process.exit(1);
}
if (prompt === 'wait' || prompt === 'wait-ignore') {
  if (prompt === 'wait-ignore') process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else {
  event('model.streaming', { kind: 'reasoning_delta', delta: secret });
  event('model.streaming', { kind: 'tool_call', toolCallId: 'read-' + turnId, toolName: 'Read', input: { file_path: 'smoke.txt' } });
  event('tool.updated', { kind: 'scheduled', toolCallId: 'read-' + turnId, toolName: 'Read', inputOmitted: true });
  event('tool.updated', { kind: 'started', toolCallId: 'read-' + turnId, toolName: 'Read' });
  event('tool.updated', { kind: 'result', toolCallId: 'read-' + turnId, toolName: 'Read', result: { content: 'ZC_NATIVE_FILE_READ_OK' }, duration: 1 });
  event('model.streaming', { kind: 'text_start', assistantMessageId });
  const response = prompt === 'fragment' ? 'Hello 你好 👋' : 'ZC_NATIVE_FILE_READ_OK';
  for (const delta of [response.slice(0, 3), response.slice(3)]) {
    const frame = { type: 'model.streaming', eventId: randomUUID(), seq: ++seq, sessionId, turnId, timestamp: Date.now(), payload: { kind: 'text_delta', assistantMessageId, delta } };
    const bytes = Buffer.from(JSON.stringify(frame) + '\n');
    if (prompt === 'fragment') for (let i = 0; i < bytes.length; i++) process.stdout.write(bytes.subarray(i, i + 1));
    else process.stdout.write(bytes);
  }
  event('model.streaming', { kind: 'finish', assistantMessageId, done: true });
  event('turn.completed', { response, toolCallCount: 1, resultType: 'success', usage: { totalTokens: 10, inputTokens: 6, outputTokens: 4, secret } });
  if (prompt === 'missing-result') process.exit(0);
  const result = { type: 'result', sessionId: prompt === 'wrong-session' ? 'sess_foreign' : sessionId, turnId, response, projection: { status: 'idle' }, usage: { totalTokens: 10, secret } };
  if (prompt === 'final-no-newline') process.stdout.write(JSON.stringify(result)); else write(result);
  if (prompt === 'extra-result') write(result);
  process.exitCode = prompt === 'nonzero' ? 2 : 0;
}
