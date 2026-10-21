import { resolveRuntime, runtimeEnvironment } from '../runtime.mjs';
import { spawnProcess, killTree, runProcess } from '../process.mjs';
import { abortError, throwIfAborted, id } from '../util.mjs';
import { WorkspaceState } from '../state.mjs';
import { StreamStore } from './stream-store.mjs';
import { StreamDecoder, StreamTurn, STREAM_CLIENT_VERSION, STREAM_RUNTIME_VERSION, STREAM_NOTICE,
  streamArguments, streamModel, streamErrorMessage, streamVersionIdentity } from './stream-contract.mjs';

export async function probeStreamRuntime(runtime, cwd) {
  const result = await runProcess(runtime.command, [...runtime.args, '--version'], { cwd, timeout: 8000, maxBytes: 2000 });
  const identity = streamVersionIdentity(result.output);
  if (result.code !== 0 || result.timedOut || result.truncated || !identity) {
    throw new Error(`Native stream preview accepts zcode-app-cli 3.15.3-36 or ${STREAM_CLIENT_VERSION} with runtime ${STREAM_RUNTIME_VERSION}. Prefer ${STREAM_CLIENT_VERSION} for its upstream authentication repair. The configured executable did not report a supported pair. No model request was sent; no fallback was attempted.`);
  }
  return identity;
}

/** Run one bounded headless process. Completion needs both valid result and exit 0. */
export async function runNativeStream({ runtime, cwd, model, text, sessionId, emit, onSession, signal,
  idleTimeout = 180000, totalTimeout = 900000, shutdownMs = 2500, spawnImpl = spawnProcess }) {
  throwIfAborted(signal);
  const args = streamArguments({ model, text, sessionId });
  return await new Promise((resolve, reject) => {
    let child;
    try { child = spawnImpl(runtime.command, [...runtime.args, ...args], {
      cwd, env: process.env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    }); } catch (error) { reject(error); return; }
    let failure, settled = false, idleTimer, totalTimer, hardTimer, finalTimer, exitTimer;
    let diagnosticTail = '', diagnosticHint;
    const turn = new StreamTurn({ emit, expectedSession: sessionId, onSession });
    const decoder = new StreamDecoder(frame => { touch(); if (!failure) turn.frame(frame); });
    const cleanup = () => {
      for (const timer of [idleTimer, totalTimer, hardTimer, finalTimer, exitTimer]) clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      child.stdout.off('data', output); child.stderr.off('data', diagnostic);
    };
    const finish = (error, result) => {
      if (settled) return; settled = true; cleanup(); error ? reject(error) : resolve(result);
    };
    const terminate = error => {
      if (settled || failure) return;
      failure = error;
      // A graceful stop first gives the runtime a chance to save its own state.
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
        else child.kill('SIGTERM');
      } catch { /* The child might already have exited. */ }
      hardTimer = setTimeout(() => { void killTree(child); }, shutdownMs);
      finalTimer = setTimeout(() => finish(failure), shutdownMs + 1500);
    };
    const touch = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => terminate(new Error('ZCode stopped sending stream events. The turn was stopped, not replayed. Inspect its state before continuing.')), idleTimeout); };
    const cancel = () => terminate(abortError());
    const output = chunk => {
      if (settled || failure) return;
      try { decoder.feed(chunk); } catch (error) { terminate(error); }
    };
    const diagnostic = chunk => {
      // Keep only a small ephemeral scanner buffer. Never print or persist stderr.
      diagnosticTail = (diagnosticTail + chunk.toString('utf8')).slice(-4096);
      diagnosticHint ||= streamErrorMessage(diagnosticTail);
    };
    child.stdout.on('data', output); child.stderr.on('data', diagnostic);
    child.stdout.on('error', () => terminate(new Error('The ZCode stdout pipe failed. Raw diagnostics were withheld.')));
    child.stderr.on('error', () => { /* A diagnostic pipe failure does not imply model failure. */ });
    child.once('error', () => finish(new Error('Could not start the configured ZCode client. Run zc doctor and check its path.')));
    child.once('exit', () => {
      if (!settled) exitTimer = setTimeout(() => terminate(new Error('The ZCode process exited but its output pipes did not close. Inspect the interrupted session.')), 1500);
    });
    child.once('close', (code, exitSignal) => {
      if (settled) return;
      try {
        if (failure) throw failure;
        decoder.end();
        if (code !== 0 || exitSignal) throw new Error(diagnosticHint || `ZCode exited without success (exit ${Number.isInteger(code) ? code : 'signal'}). Raw diagnostics were withheld. No input was replayed.`);
        const result = turn.finish();
        finish(null, result);
      } catch (error) { finish(error); }
    });
    signal?.addEventListener('abort', cancel, { once: true });
    touch(); totalTimer = setTimeout(() => terminate(new Error('ZCode reached the total turn time limit. Inspect its saved session before continuing.')), totalTimeout);
    if (signal?.aborted) cancel();
  });
}

/** Opt-in adapter for the independently tested headless entry point, not app-server. */
export class NativeStreamBackend {
  constructor({ cwd, config, emit, storeHome, probe = probeStreamRuntime, run = runNativeStream }) {
    Object.assign(this, { cwd, config, emit, probe, run });
    this.store = new StreamStore(cwd, config.runtime, storeHome); this.display = new WorkspaceState();
    this.model = config.streamModel || undefined;
  }
  get needsModel() { return !this.model; }
  async start(resumeId) {
    if (this.config.mode !== 'guarded') throw new Error('Native stream requires --mode guarded. It cannot implement ZC ask-mode approvals or strict read-only. The policy was not silently changed.');
    if (this.model) streamModel(this.model);
    this.resolvedRuntime = resolveRuntime(this.config.runtime);
    this.runtimeIdentity = await this.probe(this.resolvedRuntime, this.cwd);
    this.record = resumeId ? await this.store.load(resumeId) : this.store.create(this.model || '');
    this.release = await this.store.acquire(this.record.id);
    if (resumeId) {
      // A resume selects its saved model, never a recently changed global default.
      this.model = this.record.model || undefined;
      if (this.model) streamModel(this.model);
      for (const entry of this.record.entries) this.event(entry.role === 'tool'
        ? { ...entry, type: 'tool' } : { type: 'message', id: entry.id, role: entry.role, text: entry.text });
      if (this.record.status !== 'idle' && this.record.status !== 'new') this.event({ type: 'notice', text: 'This stream session was previously interrupted or failed. Resume was explicitly requested; inspect the original client before submitting more work. No old prompt was replayed.' });
    }
    this.event({ type: 'notice', text: STREAM_NOTICE });
    if (this.runtimeIdentity?.client === '3.15.3-36') this.event({ type: 'notice', text: 'Upstream client 3.15.3-36 predates the shared-OAuth repair in 3.15.3-37. See docs/AUTH-RECOVERY.md. ZC has not changed your installation or credentials.' });
    this.event({ type: 'session', id: this.record.id, model: this.model || 'No stream model selected. Use /model providerId/modelId.' });
    if (!this.model) this.event({ type: 'notice', text: 'Choose the exact account-backed provider/model that works in your existing ZCode client with /model. No model catalog or default was guessed.' });
    return { id: this.record.id, needsModel: this.needsModel };
  }
  event(event) { this.display.apply(event); this.emit(event); }
  async save() {
    this.record.entries = this.display.entries; this.record.updatedAt = Date.now();
    await this.store.save(this.record);
  }
  async send(text, signal) {
    if (this.active) throw new Error('A stream turn is already running.');
    if (this.disposed) throw new Error('This stream backend has been closed.');
    if (this.needsModel) throw new Error('No stream model selected. Use /model providerId/modelId. Your prompt was not sent.');
    if (!this.record.nativeSessionId && this.record.status !== 'new') throw new Error('The previous attempt has no confirmed upstream session ID. Use /new after inspecting the original client; ZC will not silently create a replacement conversation.');
    throwIfAborted(signal);
    streamArguments({ model: this.model, text, sessionId: this.record.nativeSessionId });
    const controller = new AbortController();
    const cancel = () => controller.abort(); signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    this.activeController = controller;
    const perform = async () => {
      this.event({ type: 'message', id: id(), role: 'user', text });
      this.event({ type: 'status', phase: 'working', detail: 'Starting authenticated ZCode stream' });
      this.record.status = 'running'; this.record.title ||= text.replace(/\s+/g, ' ').slice(0, 100);
      try {
        await this.save();
        const result = await this.run({ runtime: this.resolvedRuntime, cwd: this.cwd, model: this.model, text,
          sessionId: this.record.nativeSessionId, signal: controller.signal, idleTimeout: this.config.requestTimeoutMs,
          onSession: sessionId => { this.record.nativeSessionId = sessionId; }, emit: event => this.event(event) });
        this.record.nativeSessionId = result.sessionId; this.record.status = 'idle';
      } catch (error) {
        this.record.status = error.name === 'AbortError' ? 'interrupted' : 'failed'; throw error;
      } finally {
        for (const entry of this.display.entries) if (entry.role === 'tool' && ['running', 'queued'].includes(entry.status)) entry.status = 'cancelled';
        this.event({ type: 'status', phase: 'idle' });
        await this.save();
      }
    };
    this.active = perform();
    try { await this.active; }
    finally { signal?.removeEventListener('abort', cancel); this.active = undefined; this.activeController = undefined; }
  }
  async sessions() { return this.store.list(); }
  async setModel(value) {
    if (this.active) throw new Error('Stop the running turn first.');
    streamModel(value); this.model = value; this.record.model = value;
    this.event({ type: 'session', id: this.record.id, model: value });
    this.event({ type: 'notice', text: 'Exact model reference selected locally. Availability will be validated by ZCode on your next explicit prompt. No inference request was made.' });
    await this.save();
  }
  async setMode() { throw new Error('Native stream is limited to guarded mode with the documented exclusions. It cannot supply ZC approval dialogs or strict read-only.'); }
  async compact() { throw new Error('Manual compaction is not integrated for native stream. Automatic context management belongs to ZCode. Start /new or use the original client.'); }
  async dispose() {
    if (this.disposed) return; this.disposed = true;
    this.activeController?.abort();
    try { await this.active; } catch { /* send owns the error and interrupted-state record. */ }
    await this.release?.();
  }
}
