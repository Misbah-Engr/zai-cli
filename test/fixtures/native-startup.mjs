import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
// Regression fixture for observed startup requests. It is not the official runtime.
const sid = 'startup-fixture-session';
let mode = 'guarded', pendingCreate, current, sent = 0, selected = 0;
const write = frame => process.stdout.write(JSON.stringify(frame) + '\n');
const response = (id, result) => write({ id, result });
const available = [
  { ref: { providerId: 'fixture-account', modelId: 'model-a' }, label: 'Account Model' },
  { ref: { providerId: 'fixture', modelId: 'model-b' }, label: 'Reasoning Model', reasoning: { levels: [{ value: 'high', label: 'High' }], defaultLevel: 'high' } },
  { ref: { providerId: 'fixture', modelId: 'locked' }, label: 'Disabled Model', disabledReason: 'Not available for this fixture.' },
];
const snapshot = () => ({ protocol: { name: 'ZCode Protocol', version: 1 }, session: { sessionId: sid, mode, ...(current ? { model: current } : {}) }, messages: [], settings: { model: { available, ...(current ? { current } : {}) } }, runtime: {}, projection: {} });
const rl = createInterface({ input: process.stdin });
rl.on('line', line => {
  const request = JSON.parse(line), p = request.params || {};
  if (request.id === 'startup-preferences') {
    assert.deepEqual(request.result, { nativeSearchEnhancementsEnabled: false, subagentRuntimeConfigEnabled: false, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: false, modelContextBudgetStrategy: 'preflight-v1' });
    write({ id: 'startup-mcp', method: 'interaction/requestOfficialMcpAuthHeaders', params: { requestId: 'mcp:1', workspace: pendingCreate.params.workspace, pluginId: 'fixture-plugin', mcpKey: 'fixture-mcp', targetOrigin: 'https://example.invalid' } }); return;
  }
  if (request.id === 'startup-mcp') {
    assert.deepEqual(request.result, { ok: false, reason: 'official_auth_unavailable' });
    response(pendingCreate.id, snapshot()); return;
  }
  if (request.id === 'account-auth') {
    assert.equal(request.result.headersApplied, false);
    assert.match(request.result.errorMessage, /account-provider authentication bridge/);
    response('diagnostic-account-result', request.result); return;
  }
  switch (request.method) {
    case 'session/setMode': mode = p.mode; response(request.id, snapshot()); return;
    case 'session/create': mode = p.mode;
      assert.equal(p.mode, 'plan'); assert.deepEqual(p.toolAllowlist, ['Read', 'Glob', 'Grep']);
      pendingCreate = request;
      write({ id: 'startup-preferences', method: 'session/requestRuntimePreferences', params: { sessionId: sid, scope: 'runtime-materialization' } }); break;
    case 'session/subscribe': response(request.id, { sessionId: sid, eventSeq: 0, events: [], snapshot: snapshot() }); break;
    case 'session/read': response(request.id, snapshot()); break;
    case 'session/setModel':
      assert.equal(p.persistAsWorkspaceLastUsed, false);
      assert.equal(p.sessionId, sid);
      assert.ok(available.some(m => !m.disabledReason && m.ref.providerId === p.model.providerId && m.ref.modelId === p.model.modelId));
      current = p.model; selected++; response(request.id, snapshot()); break;
    case 'session/send': sent++; response(request.id, { sessionId: sid, accepted: true }); break;
    case 'fixture/stats': response(request.id, { sent, selected }); break;
    default: write({ id: request.id, error: { code: -32601, message: 'Unknown fixture request.' } });
  }
});
rl.on('close', () => process.exit(0));
