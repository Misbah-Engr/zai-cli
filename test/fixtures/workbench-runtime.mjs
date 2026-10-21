// Synthetic RPC runtime used only by local UI tests. No network, credentials, or real tools.
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const sid = 'workbench-fixture-session', model = { providerId: 'fixture', modelId: 'model' };
let seq = 0, mode = 'guarded', turn = null, running = false, history = [], events = [];
const log = frame => { if (process.env.ZC_FIXTURE_LOG) appendFileSync(process.env.ZC_FIXTURE_LOG, JSON.stringify(frame) + '\n'); };
const write = frame => process.stdout.write(JSON.stringify(frame) + '\n');
const response = (id, result) => write({ id, result });
const event = (type, payload) => { const ev = { type, payload, eventId: String(++seq), seq, sessionId: sid, turnId: turn, timestamp: Date.now() }; events.push(ev); write({ method: 'session/event', params: ev }); };
const snapshot = () => ({ protocol: { name: 'ZCode Protocol', version: 1 }, session: { sessionId: sid, mode, status: running ? 'running' : 'idle', model, title: 'Workbench fixture' }, messages: history, settings: { mode: { current: mode }, model: { current: model, available: [{ ref: model, label: 'Fixture model' }] } }, runtime: { mainActive: running }, projection: { status: running ? 'running' : 'idle', pendingPermissions: [] } });
const record = (role, messageId, text) => history.push({ info: { role, messageId }, parts: [{ type: 'text', text }] });
function complete(input, text) {
  event('model.streaming', { kind: 'text_start', assistantMessageId: 'a' + turn });
  for (const delta of text.match(/.{1,80}/gs) || []) event('model.streaming', { kind: 'text_delta', assistantMessageId: 'a' + turn, delta });
  record('assistant', 'a' + turn, text); running = false;
  event('turn.completed', { inputId: input.inputId, response: text, resultType: 'success' });
}
const rl = createInterface({ input: process.stdin });
rl.on('line', line => {
  const r = JSON.parse(line), p = r.params || {}; log(r);
  switch (r.method) {
    case 'session/create': mode = p.mode; response(r.id, snapshot()); break;
    case 'session/resume': response(r.id, snapshot()); break;
    case 'session/read': response(r.id, snapshot()); break;
    case 'session/events': response(r.id, { events: events.filter(e => e.seq > p.afterSeq).slice(0, p.limit) }); break;
    case 'session/setMode': mode = p.mode; response(r.id, snapshot()); break;
    case 'session/subscribe': response(r.id, { sessionId: sid, events: [], eventSeq: seq, snapshot: snapshot() }); break;
    case 'session/list': response(r.id, { sessions: [{ sessionId: sid, title: 'Workbench fixture', updatedAt: Date.now() }] }); break;
    case 'session/send': {
      turn = 't' + seq; running = true; record('user', p.inputId, p.content);
      // Deliberately omit inputId and queryId in this start to exercise legacy correlation.
      event('turn.started', { input: p.content }); response(r.id, { sessionId: sid, accepted: true });
      if (p.content === 'quiet') break;
      event('tool.updated', { kind: 'scheduled', toolCallId: 'tool' + turn, toolName: 'Read', input: { path: 'fixture.txt' } });
      event('tool.updated', { kind: 'result', toolCallId: 'tool' + turn, toolName: 'Read', result: { text: 'Fixture contents' }, duration: 1 });
      complete(p, '# Synthetic response\n\n' + Array.from({ length: 90 }, (_, i) => `History line ${i}: readable output retained for scrolling.`).join('\n')); break;
    }
    case 'session/stop': running = false; response(r.id, {}); event('turn.completed', { resultType: 'cancelled' }); break;
    default: response(r.id, {});
  }
});
rl.on('close', () => process.exit(0));
