import { createInterface } from 'node:readline';
const sessionId = 'native-fixture-session'; let seq = 0, inputId, mode = 'guarded';
let model = { providerId: 'fixture', modelId: 'glm' };
const write = frame => process.stdout.write(JSON.stringify(frame) + '\n');
const response = (id, result) => write({ id, result });
const snapshot = () => ({ protocol: { name: 'ZCode Protocol', version: 1 }, session: { sessionId, mode, model, title: 'Fixture session' }, messages: [], settings: { model: { current: model, available: [{ ref: { providerId: 'fixture', modelId: 'glm' }, label: 'Fixture GLM' }] } }, projection: {}, runtime: {} });
const event = (type, payload) => write({ method: 'session/event', params: { eventId: String(seq + 1), sessionId, turnId: 'turn-fixture', seq: ++seq, timestamp: Date.now(), type, payload } });
const rl = createInterface({ input: process.stdin });
rl.on('line', line => {
  const request = JSON.parse(line);
  if (request.id === 'approve-once' && request.result) {
    event('tool.updated', { kind: 'result', toolCallId: 'tool-fixture', toolName: 'Read', result: { text: request.result.decision }, duration: 1 });
    event('model.streaming', { kind: 'text_start', assistantMessageId: 'assistant-fixture' });
    event('model.streaming', { kind: 'text_delta', assistantMessageId: 'assistant-fixture', delta: 'Native fixture says 你好.' });
    event('turn.completed', { inputId, response: 'Native fixture says 你好.', resultType: 'success' }); return;
  }
  const p = request.params || {};
  switch (request.method) {
    case 'session/create': mode = p.mode; response(request.id, snapshot()); break;
    case 'session/resume': mode = 'yolo'; response(request.id, snapshot()); break;
    case 'session/setMode': mode = p.mode; response(request.id, snapshot()); break;
    case 'session/subscribe': response(request.id, { sessionId, eventSeq: seq, events: [], snapshot: snapshot() }); break;
    case 'session/send':
      inputId = p.inputId; event('turn.started', { inputId });
      response(request.id, { sessionId, accepted: true, stateRevision: 1 });
      event('tool.updated', { kind: 'scheduled', toolCallId: 'tool-fixture', toolName: 'Read', input: { path: 'source.ts' } });
      const permission = { id: 'approve-once', method: 'interaction/requestPermission', params: { requestId: 'permission-key', sessionId, toolCallId: 'tool-fixture', toolName: 'Read', input: { path: 'source.ts' }, reason: 'Fixture approval', options: [{ response: { decision: 'allow' } }], riskLevel: 'low' } };
      write(permission); write(permission); break;
    case 'session/list': response(request.id, { sessions: [{ sessionId, title: 'Fixture session', updatedAt: Date.now() }] }); break;
    case 'session/read': response(request.id, snapshot()); break;
    case 'session/setModel': model = p.model; response(request.id, snapshot()); break;
    case 'session/stop': response(request.id, {}); event('turn.completed', { inputId, resultType: 'cancelled' }); break;
    case 'session/compact': response(request.id, { response: 'Compaction accepted.', snapshot: snapshot() }); break;
    default: response(request.id, {});
  }
});
rl.on('close', () => process.exit(0));
console.error('Fixture diagnostics stay off the protocol channel.');
