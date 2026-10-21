import { once } from 'node:events';
import { NativeTurn } from './native-turn.mjs';
import { resolveRuntime, runtimeEnvironment } from '../runtime.mjs';
import { ProtocolClient } from '../protocol.mjs';
import { spawnProcess, killTree } from '../process.mjs';
import { hash, id, bounded, isRecord, abortError, redact } from '../util.mjs';

import { NATIVE_MODES, snapshotPermissionMode, localPermissionMode, fullAccessConfirmation } from './native-mode.mjs';

export const UPSTREAM_COMMIT = 'aac4755666d09fdcd70272fcf063c077a639015f';
export { parseNativeModel } from './native-contract.mjs';
import { parseNativeModel, formatNativeModel, snapshotModel, nativeModelCatalog, runtimePreferences, NATIVE_ACCOUNT_AUTH_UNAVAILABLE } from './native-contract.mjs';
export function snapshotMessages(snapshot) {
  const entries = [];
  for (const record of snapshot.messages || []) {
    const info = record.info;
    if (!isRecord(info) || info.visibility === 'model-only' || (info.semantics && info.semantics.uiVisibility !== 'visible')) continue;
    if (!['user', 'assistant'].includes(info.role)) continue;
    const text = (record.parts || []).filter(p => p.type === 'text' && !p.ignored).map(p => p.text || '').join('\n');
    if (text) entries.push({ type: 'message', id: info.messageId, role: info.role, text });
    for (const part of record.parts || []) if (part.type === 'tool') entries.push({ type: 'tool', id: part.callId, name: part.tool, input: part.state?.input,
      status: part.state?.status === 'completed' ? 'done' : part.state?.status || 'unknown', output: part.state?.output || part.state?.error });
  }
  return entries;
}

/** Experimental client for the inspected legacy v1 contract, not a v4 implementation. */
export class NativeBackend {
  constructor({ cwd, config, emit, ask, spawnImpl = spawnProcess }) {
    this.cwd = cwd; this.config = config; this.emit = emit; this.ask = ask; this.spawnImpl = spawnImpl;
    this.workspace = { workspacePath: cwd, workspaceKey: `zc:${hash(cwd).slice(0, 32)}` };
    this.launchReadOnly = config.mode === 'read-only'; this.mode = config.mode; this.runtimeMode = undefined;
    this.modeUnknown = true; this.modeChanging = false;
    this.seq = -1; this.requestCache = new Map(); this.notices = new Set(); this.modelOptions = [];
  }
  async start(resumeId) {
    this.needsReconnect = false;
    const runtime = resolveRuntime(this.config.runtime);
    this.child = this.spawnImpl(runtime.command, [...runtime.args, 'app-server', '--stdio'], {
      cwd: this.cwd, env: runtimeEnvironment(runtime), detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.stderr = '';
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', text => { this.stderr = (this.stderr + text).slice(-6000); });
    this.rpc = new ProtocolClient(this.child.stdout, this.child.stdin, { timeoutMs: 60000, onRequest: (method, params) => this.interaction(method, params) });
    this.child.once('error', error => this.rpc.fail(new Error(`Could not launch the ZCode runtime: ${error.message}. Run zc doctor.`)));
    this.child.once('close', code => {
      if (!this.disposing && !this.rpc.closed) this.rpc.fail(new Error(`ZCode runtime exited (${code}). Use /reconnect to inspect the saved session. Raw diagnostics were not displayed.`));
    });
    this.rpc.on('fault', error => {
      this.needsReconnect = true; this.active?.finish(error);
      if (!this.disposing) { this.emit({ type: 'status', phase: 'disconnected', detail: 'Runtime disconnected. /reconnect inspects and resumes the saved session.' }); this.emit({ type: 'notice', error: true, text: error.message }); }
    });
    this.rpc.on('notification', (method, params) => this.notification(method, params));
    const initialMode = this.launchReadOnly ? 'plan' : 'guarded';
    const restrictions = this.launchReadOnly ? { toolAllowlist: ['Read', 'Glob', 'Grep'] } : {};
    let snapshot = await this.rpc.request(resumeId ? 'session/resume' : 'session/create', resumeId
      ? { sessionId: resumeId, workspace: this.workspace, ...restrictions }
      : { workspace: this.workspace, mode: initialMode, persistence: 'immediate', ...restrictions });
    this.validateSnapshot(snapshot);
    this.session = snapshot.session;
    if (resumeId) {
      await this.rpc.request('session/setMode', { sessionId: this.session.sessionId, mode: initialMode });
    }
    const subscription = await this.rpc.request('session/subscribe', { sessionId: this.session.sessionId, deliveryKind: 'desktop-continuous', includeSnapshot: true });
    if (!isRecord(subscription) || !Array.isArray(subscription.events)) throw new Error('Unsupported ZCode subscription response. Use the pinned upstream revision.');
    snapshot = subscription.snapshot || snapshot;
    this.validateSnapshot(snapshot);
    for (const entry of snapshotMessages(snapshot)) this.emit(entry);
    // The snapshot already includes replayed state. Do not append its old deltas again.
    this.seq = Number.isInteger(subscription.eventSeq) ? subscription.eventSeq : -1;
    this.applyModelSnapshot(snapshot);
    this.confirmMode(snapshot, initialMode);
    this.emit({ type: 'notice', text: 'Connected. /mode controls permissions. Tool access is not confined by an OS sandbox.' });
    if (!this.model) this.emit({ type: 'notice', text: this.modelOptions.length
      ? 'No model is selected. Open /model to choose from the runtime catalog. Nothing has been sent to a model.'
      : 'The runtime returned no selected model and no model options. Verify your model configuration in the official ZCode CLI. No provider ID was guessed.' });
    return { id: this.session.sessionId, needsModel: !this.model, models: this.modelOptions };

  }
  validateSnapshot(value) {
    if (!isRecord(value) || value.protocol?.name !== 'ZCode Protocol' || value.protocol?.version !== 1 || typeof value.session?.sessionId !== 'string' || !Array.isArray(value.messages)) throw new Error('Unsupported ZCode runtime snapshot. This adapter targets the inspected legacy v1 contract, not protocol v4.');
  }
  noticeOnce(key, text, error = false) {
    if (this.notices.has(key)) return;
    if (this.notices.size >= 64) return;
    this.notices.add(key); this.emit({ type: 'notice', error, text });
  }
  applyModelSnapshot(snapshot) {
    this.validateSnapshot(snapshot);
    if (this.session && snapshot.session.sessionId !== this.session.sessionId) throw new Error('Model snapshot belongs to a different session.');
    const modelOptions = nativeModelCatalog(snapshot), model = snapshotModel(snapshot);
    this.modelOptions = modelOptions; this.model = model; this.session = snapshot.session;
    this.emit({ type: 'session', id: this.session.sessionId, model: model ? formatNativeModel(model) : 'No model selected' });
  }
  get needsModel() { return !this.model; }
  async models() {
    const snapshot = await this.rpc.request('session/read', { sessionId: this.session.sessionId });
    this.applyModelSnapshot(snapshot); return this.modelOptions;
  }
  async interaction(method, params) {
    if (method === 'session/requestRuntimePreferences') return runtimePreferences(params, this.session?.sessionId);
    if (method === 'interaction/requestOfficialMcpAuthHeaders') {
      this.noticeOnce('official-mcp-auth', 'Optional authenticated MCP services are unavailable in this frontend. Core model, file, and shell tools use the runtime connection.');
      return { ok: false, reason: 'official_auth_unavailable' };
    }
    if (method === 'interaction/requestProviderRuntimeHeaders') {
      this.noticeOnce('provider-auth', NATIVE_ACCOUNT_AUTH_UNAVAILABLE, true);
      return { headersApplied: false, errorMessage: NATIVE_ACCOUNT_AUTH_UNAVAILABLE };
    }
    if (method === 'interaction/requestPermission') {
      if (!isRecord(params) || typeof params.toolName !== 'string' || !params.requestId || !Array.isArray(params.options)) throw new Error('Invalid permission request.');
      if (this.session && params.sessionId !== this.session.sessionId) return { decision: 'deny', reason: 'Permission request is for a different session.' };
      const key = params.requestId;
      const signature = hash(JSON.stringify([params.sessionId, params.toolCallId, params.toolName, params.input, params.options]));
      if (this.requestCache.has(key)) {
        const cached = this.requestCache.get(key);
        if (cached.signature !== signature) return { decision: 'deny', reason: 'Permission request identity was reused with different content.' };
        return await cached.promise;
      }
      if (this.requestCache.size > 256) this.requestCache.delete(this.requestCache.keys().next().value);
      const promise = (async () => {
        if (this.config.mode === 'read-only') return { decision: 'deny', reason: 'Read-only mode does not approve additional capabilities.' };
        const allowedOnce = params.options.some(option => option.response?.decision === 'allow' && !option.response.permissionUpdates?.length && !option.response.modifiedInput);
        if (!allowedOnce) return { decision: 'deny', reason: 'No one-time, unmodified approval option is available.' };
        const monitor = this.active?.monitor;
        if (monitor) monitor.waitingForApproval++;
        let approved;
        try { approved = await this.ask({ title: `Allow ${params.toolName}?`, detail: params.reason || 'Requested by the native runtime.', input: bounded(JSON.stringify(params.input, null, 2), 32000), risk: params.riskLevel || 'high' }, this.active?.signal); }
        finally { if (monitor) { monitor.waitingForApproval--; monitor.touch(); } }
        return { decision: approved ? 'allow' : 'deny', reason: approved ? 'Approved once in ZC.' : 'Denied by the user. Do not work around this denial.' };
      })();
      this.requestCache.set(key, { signature, promise }); return await promise;
    }
    // Desktop-only capabilities and authentication headers must not be fabricated.
    this.noticeOnce(`unsupported:${method}`, `Unsupported native interaction: ${method}. It was rejected, not auto-approved. See docs/COMPATIBILITY.md.`, true);
    throw Object.assign(new Error(`ZC does not implement ${method}.`), { code: -32601 });
  }
  notification(method, params) {
    if (method === 'startup/storageState') {
      this.emit({ type: 'status', phase: 'connecting', detail: `Runtime storage: ${params?.phase || 'starting'}` }); return;
    }
    if (method !== 'session/event' || !isRecord(params)) return;
    const event = params;
    if (event.sessionId !== this.session?.sessionId) return;
    if (!Number.isInteger(event.seq) || event.seq <= this.seq) return;
    this.seq = event.seq;
    this.active?.touch();
    this.active?.monitor.observe(event);
    const p = event.payload || {};
    if (event.type === 'model.streaming') {
      if (p.kind === 'tool_call' && p.toolCallId) this.emit({ type: 'tool', id: p.toolCallId, name: p.toolName, input: p.input, status: 'queued' });
      if (p.kind === 'text_start') this.lastTextId = p.assistantMessageId || p.partId || id();
      if (p.kind === 'text_delta' && typeof p.delta === 'string') {
        this.lastTextId = p.assistantMessageId || this.lastTextId || p.partId || id();
        this.emit({ type: 'delta', id: this.lastTextId, text: p.delta });
      }
      if (p.kind === 'reasoning_start') this.emit({ type: 'status', phase: 'working', detail: 'Thinking' });
    }
    if (event.type === 'tool.updated' && p.toolCallId) {
      const status = { scheduled: 'queued', started: 'running', result: 'done', error: 'error', progress: 'running' }[p.kind];
      if (status) this.emit({ type: 'tool', id: p.toolCallId, name: p.toolName, input: p.input, status,
        output: p.kind === 'result' ? bounded(JSON.stringify(p.result, null, 2)) : p.kind === 'error' ? p.error?.message : p.stdoutTail || p.stderrTail,
        duration: p.duration });
    }
    if (['turn.completed', 'turn.failed'].includes(event.type) && this.matchesActive(event)) this.completeTurn(event);
  }
  completeTurn(event) {
    if (!this.matchesActive(event)) return;
    const p = event.payload || {};
    if (event.type === 'turn.failed') { this.active.finish(new Error(p.error?.message || 'Native turn failed.')); return; }
    if (p.response) this.emit({ type: 'message', id: this.lastTextId || id(), role: 'assistant', text: p.response });
    if (p.usage) this.emit({ type: 'usage', usage: p.usage });
    if (p.resultType === 'cancelled') this.active.finish(abortError());
    else if (p.resultType && p.resultType !== 'success') this.active.finish(new Error(`Runtime stopped: ${p.resultType}`));
    else this.active.finish();
  }
  matchesActive(event) { return this.active?.monitor.matches(event) === true; }
  async inspect() {
    if (!this.rpc || this.rpc.closed) throw new Error('Runtime disconnected. Use /reconnect.');
    const snapshot = await this.rpc.request('session/read', { sessionId: this.session.sessionId }, { timeoutMs: 15000 });
    this.validateSnapshot(snapshot);
    return { sessionId: this.session.sessionId, status: snapshot.session.status || snapshot.projection?.status || 'unknown',
      mainActive: snapshot.runtime?.mainActive, mode: snapshot.settings?.mode?.current || snapshot.session.mode,
      pendingPermissions: snapshot.projection?.pendingPermissions?.length || 0, backgroundJobs: snapshot.projection?.backgroundJobs?.length || 0,
      frontendTurn: Boolean(this.active), connection: this.rpc.closed ? 'closed' : 'open' };
  }
  async send(text, signal) {
    if (this.modeChanging) throw new Error('A permission-mode change is pending. No prompt was sent.');
    if (this.modeUnknown) throw new Error('Runtime permission mode is unconfirmed. Use /mode ask to reconcile it before sending another prompt.');
    if (this.active) throw new Error('A native turn is already running.');
    if (this.rpc.closed || this.needsReconnect) throw new Error('Connection needs inspection. Use /status or /reconnect before sending another task. No prompt was sent.');
    if (!this.model) throw new Error('No native model selected. Open /model and choose a runtime-provided option. Your prompt was not sent.');
    if (signal?.aborted) throw abortError();
    this.lastTextId = undefined;
    const inputId = id();
    this.emit({ type: 'message', id: inputId, role: 'user', text });
    this.emit({ type: 'status', phase: 'working', detail: 'Waiting for the model' });
    await new Promise((resolve, reject) => {
      const finish = error => {
        if (this.active?.inputId !== inputId) return;
        this.active.monitor.close(); signal?.removeEventListener('abort', cancel); this.active = undefined;
        this.emit({ type: 'status', phase: this.needsReconnect ? 'uncertain' : 'idle', detail: this.needsReconnect ? 'Inspect session before sending another task' : '' });
        error ? reject(error) : resolve();
      };
      const monitor = new NativeTurn({ inputId, text, afterSeq: this.seq, signal, rpc: this.rpc, sessionId: this.session.sessionId,
        emit: this.emit, complete: event => this.completeTurn(event), intervalMs: this.config.requestTimeoutMs });
      monitor.onUnconfirmed = error => { this.needsReconnect = true; finish(error); };
      const cancel = () => {
        this.emit({ type: 'status', phase: 'stopping', detail: 'Stopping the current turn' });
        void this.rpc.request('session/stop', { sessionId: this.session.sessionId }, { timeoutMs: 5000 })
          .then(() => finish(abortError()), async () => { await this.dispose(); finish(abortError()); });
      };
      this.active = { inputId, signal, finish, monitor, touch: () => monitor.touch() };
      signal?.addEventListener('abort', cancel, { once: true });
      this.rpc.request('session/send', { sessionId: this.session.sessionId, inputId, queryId: inputId, content: text }).then(result => {
        if (this.active?.inputId !== inputId) return;
        monitor.accepted = result?.accepted === true;
        if (result?.turnId && !monitor.turnId) monitor.turnId = result.turnId;
      }, error => {
        if (error.code === 'RPC_TIMEOUT' && this.active?.inputId === inputId) { void monitor.probe(); return; }
        finish(error);
      });
    });
  }
  async sessions() {
    const result = await this.rpc.request('session/list', { workspace: this.workspace, limit: 50 });
    if (!Array.isArray(result.sessions)) throw new Error('Invalid native session listing.');
    return result.sessions.map(s => ({ id: s.sessionId, title: s.title, updatedAt: s.updatedAt }));
  }
  async setModel(value) {
    const model = parseNativeModel(value);
    const options = await this.models();
    const candidate = options.find(option => option.value === value);
    if (!candidate) throw new Error('That exact model and reasoning level are not in the runtime catalog. Open /model to select an available option.');
    if (candidate.disabled) throw new Error(`The runtime marked this model unavailable: ${candidate.disabledReason}`);
    const result = await this.rpc.request('session/setModel', { sessionId: this.session.sessionId, model, persistAsWorkspaceLastUsed: false });
    const snapshot = result?.protocol ? result : await this.rpc.request('session/read', { sessionId: this.session.sessionId });
    this.applyModelSnapshot(snapshot);
    if (!this.model || formatNativeModel(this.model) !== value) throw new Error('The runtime did not confirm that exact model selection. Open /model to inspect its current state.');
  }
  confirmMode(snapshot, expected) {
    this.validateSnapshot(snapshot);
    const actual = snapshotPermissionMode(snapshot, this.session.sessionId);
    if (actual !== expected) throw new Error(`Runtime reported ${actual}, not requested ${expected}.`);
    this.session = snapshot.session;
    this.runtimeMode = actual; this.mode = localPermissionMode(actual); this.modeUnknown = false;
    this.emit({ type: 'mode', mode: this.mode, runtimeMode: actual });
  }
  async setMode(value, signal) {
    if (!Object.hasOwn(NATIVE_MODES, value)) throw new Error('Native modes: ask or yolo. Read-only restrictions require a new launch.');
    if (this.launchReadOnly || value === 'read-only') {
      if (this.launchReadOnly && value === 'read-only') return { changed: false, mode: this.mode };
      throw new Error('Native tool restrictions are set at session creation. Start a new launch with --mode ask or --mode read-only. No tools or permissions were changed.');
    }
    if (this.active || this.modeChanging) throw new Error('Stop the active turn or finish the pending mode change first.');
    if (this.disposing || !this.session || !this.rpc || this.rpc.closed) throw new Error('No native runtime is connected. Reconnect before changing mode.');
    if (signal?.aborted) throw abortError();
    const sessionId = this.session.sessionId, target = NATIVE_MODES[value];
    this.modeChanging = true;
    let mutationSent = false;
    try {
      const before = await this.rpc.request('session/read', { sessionId });
      this.validateSnapshot(before);
      const previous = snapshotPermissionMode(before, sessionId);
      if (before.runtime?.mainActive === true || ['running', 'waiting'].includes(before.session.status)) throw new Error('Stop the runtime turn before changing mode.');
      if (signal?.aborted || this.disposing) throw abortError();
      // No dialog is repeated after this frontend has confirmed YOLO for this session.
      if (!this.modeUnknown && this.runtimeMode === target && previous === target) {
        return { changed: false, mode: this.mode, runtimeMode: previous };
      }
      if (value === 'yolo') {
        const approved = await this.ask(fullAccessConfirmation(this.cwd), signal);
        if (!approved || signal?.aborted || this.disposing) return { changed: false, mode: this.mode, declined: true };
      }
      if (signal?.aborted || this.disposing || this.session.sessionId !== sessionId) throw abortError();
      mutationSent = true;
      // Once dispatched, always consume its answer. An aborted local wait cannot undo a remote mode change.
      const result = await this.rpc.request('session/setMode', { sessionId, mode: target });
      const after = result?.protocol ? result : await this.rpc.request('session/read', { sessionId });
      this.confirmMode(after, target);
      // Confirmation does not submit, replay, or manufacture a user task.
      return { changed: true, mode: this.mode, runtimeMode: this.runtimeMode };
    } catch (error) {
      if (mutationSent) {
        this.modeUnknown = true; this.mode = 'unknown'; this.runtimeMode = undefined;
        this.emit({ type: 'mode', mode: 'unknown', runtimeMode: 'unknown' });
        throw new Error(`Permission change could not be confirmed: ${redact(error.message)} The runtime may have applied it. No further prompts will be sent until /mode ask succeeds, or you quit and reconnect.`);
      }
      throw error;
    } finally { this.modeChanging = false; }
  }
  async compact() {
    if (this.modeChanging || this.modeUnknown) throw new Error('Confirm the runtime mode with /mode ask before compaction.');
    const result = await this.rpc.request('session/compact', { sessionId: this.session.sessionId, inputId: id() });
    this.emit({ type: 'notice', text: result.response || 'Compaction requested from the runtime.' });
  }
  async dispose() {
    if (this.disposing) return; this.disposing = true;
    this.active?.finish(abortError());
    if (!this.child) return;
    const closed = this.child.exitCode !== null || this.child.signalCode !== null;
    if (!closed) {
      const exited = once(this.child, 'close').catch(() => {});
      this.child.stdin.end();
      let timer; await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 1800); })]); clearTimeout(timer);
      if (this.child.exitCode === null && this.child.signalCode === null) await killTree(this.child);
    }
    this.rpc?.close();
  }
}
