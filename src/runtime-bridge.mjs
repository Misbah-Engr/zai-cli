import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { resolve, isAbsolute, win32 } from 'node:path';
import { statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export function resolveRuntimeLaunch(command, { platform = process.platform, env = process.env,
  isFile = path => { try { return statSync(path).isFile(); } catch { return false; } } } = {}) {
  if (/\.(cmd|bat)$/i.test(command)) throw new Error('Use the installed zcode-app-cli bin/zcode.js path instead of a shell shim');
  if (platform === 'win32' && command === 'zcode') {
    const pathValue = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
    for (const directory of pathValue.split(';').filter(Boolean)) {
      // Only standard installed package entrypoints, never parse/execute a .cmd shim.
      const entry = win32.join(directory.replace(/^"|"$/g, ''), 'node_modules', 'zcode-app-cli', 'bin', 'zcode.js');
      if (isFile(entry)) return { command: process.execPath, args: [entry, 'app-server'] };
      const exe = win32.join(directory.replace(/^"|"$/g, ''), 'zcode.exe');
      if (isFile(exe)) return { command: exe, args: ['app-server'] };
    }
    throw new Error('On Windows, pass --runtime-path with the installed zcode-app-cli bin/zcode.js absolute path');
  }
  const absolute = platform === 'win32' ? win32.isAbsolute(command) : isAbsolute(command);
  return absolute && /\.(c?js|mjs)$/i.test(command)
    ? { command: process.execPath, args: [command, 'app-server'] }
    : { command, args: ['app-server'] };
}

// Adapter for the installed, unchanged zcode-app-cli app-server (ZCode Protocol 1).
// No model HTTP, credential-file reads, request signing, or vendored runtime.
export class RuntimeBridge extends EventEmitter {
  constructor({ command = 'zcode', cwd = process.cwd(), env = process.env,
    spawnImpl = spawn, onPermission, onUserInput, requestTimeoutMs = 120_000,
    maxLineBytes = 16 * 1024 * 1024, cancellationTimeoutMs = 5000, shutdownTimeoutMs = 1000, platform = process.platform } = {}) {
    super();
    Object.assign(this, { command, cwd: resolve(cwd), env, spawnImpl, onPermission,
      onUserInput, requestTimeoutMs, maxLineBytes, cancellationTimeoutMs, shutdownTimeoutMs, platform });
    this.pending = new Map();
    this.interactions = new Map();
    this.sequence = 0;
    this.decoder = new StringDecoder('utf8');
    this.buffer = '';
    this.closed = false;
    this.sessionId = undefined;
  }

  start() {
    if (this.closed) throw new Error('Runtime bridge is closed');
    if (this.child) return;
    // Invoke the genuine installed launcher, not an extracted runtime entrypoint.
    const launch = resolveRuntimeLaunch(this.command, { platform: this.platform, env: this.env });
    this.child = this.spawnImpl(launch.command, launch.args, {
      cwd: this.cwd, env: { ...this.env, ZCODE_APP_SERVER_AUTH_MODE: 'standalone' },
      stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true, detached: this.platform !== 'win32',
    });
    this.groupPid = this.platform !== 'win32' && Number.isInteger(this.child.pid) ? this.child.pid : undefined;
    this.child.stdout.on('data', chunk => this._read(chunk));
    this.child.stderr.on('data', chunk => this.emit('diagnostic', chunk.toString()));
    this.child.stdin.on('error', error => this._fail(error));
    this.child.on('error', error => this._fail(new Error(
      `Unable to start installed ZCode runtime (${this.command}): ${error.message}`)));
    this.child.on('close', (code, signal) => {
      this.childClosed = true;
      if (!this.groupPid) clearTimeout(this.killTimer);
      this._fail(new Error(`ZCode runtime exited (${signal ?? code ?? 'unknown'})`));
    });
  }

  _write(message) {
    if (this.closed || !this.child?.stdin?.writable) throw new Error('ZCode runtime is not connected');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}) {
    try { this.start(); } catch (error) { return Promise.reject(error); }
    const id = ++this.sequence;
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`ZCode runtime request timed out: ${method}`);
        reject(error);
        this._fail(error);
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve: resolveRequest, reject, timer });
      try { this._write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  _read(chunk) {
    if (this.closed) return;
    this.buffer += this.decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > this.maxLineBytes) return this._protocolFailure('Runtime message exceeds size limit');
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); }
      catch { return this._protocolFailure('Invalid NDJSON from ZCode runtime'); }
      if (!message || typeof message !== 'object' || Array.isArray(message)) return this._protocolFailure('Invalid runtime envelope');
      if (message.method && Object.hasOwn(message, 'id')) {
        void this._interaction(message);
      } else if (Object.hasOwn(message, 'id')) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(Object.assign(new Error(message.error.message || 'Runtime request failed'), {
          code: message.error.code, data: message.error.data,
        }));
        else if (Object.hasOwn(message, 'result')) pending.resolve(message.result);
        else pending.reject(new Error('Runtime response has no result'));
      } else if (message.method === 'session/event') this._event(message.params);
      else this.emit('notification', message);
    }
    if (Buffer.byteLength(this.buffer) > this.maxLineBytes) this._protocolFailure('Runtime message exceeds size limit');
  }

  _protocolFailure(message) {
    this._fail(new Error(message));
  }

  async _interaction(message) {
    const { id, method, params = {} } = message;
    // The backend may reannounce one interaction with a new transport id.
    const key = JSON.stringify([method, params.sessionId ?? '', params.requestId ?? id, params]);
    let resultPromise = this.interactions.get(key);
    if (!resultPromise) {
      resultPromise = (async () => {
        if (method === 'interaction/requestPermission') {
          if (!['sessionId', 'requestId', 'toolCallId', 'toolName', 'reason'].every(key => typeof params[key] === 'string' && params[key].length > 0)
            || !['low', 'medium', 'high', 'critical'].includes(params.riskLevel)
            || !Object.hasOwn(params, 'input') || !Array.isArray(params.options) || !params.options.length) {
            return { decision: 'deny', reason: 'Unrecognized permission request schema' };
          }
          this.emit('permission', params);
          const answer = await this.onPermission?.(params);
          // Only one-time decisions. Never grant persistent rules implicitly.
          return { decision: answer?.decision === 'allow' ? 'allow' : 'deny',
            reason: typeof answer?.reason === 'string' ? answer.reason : 'No one-time approval granted' };
        }
        if (method === 'interaction/requestUserInput') {
          this.emit('userInput', params);
          const answer = await this.onUserInput?.(params);
          return answer && ['accept', 'decline', 'cancel'].includes(answer.action)
            ? { action: answer.action, ...(answer.content ? { content: answer.content } : {}),
              ...(typeof answer.reason === 'string' ? { reason: answer.reason } : {}) }
            : { action: 'cancel' };
        }
        throw Object.assign(new Error(`Unsupported runtime interaction: ${method}`), { code: -32601 });
      })();
      this.interactions.set(key, resultPromise);
      if (this.interactions.size > 1024) this.interactions.delete(this.interactions.keys().next().value);
    }
    try { const result = await resultPromise; if (!this.closed) this._write({ id, result }); }
    catch (error) {
      if (!this.closed) {
        try { this._write({ id, error: { code: error.code ?? -32603, message: error.message } }); }
        catch { /* Transport failure already rejects pending operations. */ }
      }
    }
  }

  _event(event) {
    if (!event || event.sessionId !== this.sessionId) return;
    if (Number.isInteger(event.seq)) {
      if (event.seq <= (this.lastSeq ?? -1)) return;
      this.lastSeq = event.seq;
    }
    this.emit('event', event);
    const payload = event.payload ?? {};
    // Native desktop-continuous delivery carries model.streaming deltas;
    // ignore part.delta to avoid rendering the same content twice.
    if (event.type === 'model.streaming' && typeof payload.delta === 'string') {
      if (payload.kind === 'text_delta') this.emit('text', payload.delta);
      if (payload.kind === 'reasoning_delta') this.emit('reasoning', payload.delta);
    }
    if (event.type === 'tool.updated') this.emit('tool', payload);
    if (!this.turn) return;
    if (payload.inputId && payload.inputId !== this.turn.inputId) return;
    if (event.type === 'turn.completed') {
      if (payload.resultType === 'success' || payload.resultType === 'cancelled') this._settleTurn(null, payload);
      else this._settleTurn(Object.assign(new Error(`ZCode turn ended: ${payload.resultType ?? 'unknown result'}`), { result: payload }));
    }
    if (event.type === 'turn.failed') this._settleTurn(Object.assign(
      new Error(payload.error?.message || 'ZCode turn failed'), { detail: payload.error }));
  }

  async startSession({ model, resumeSessionId, mode = 'guarded', thoughtLevel } = {}) {
    if (this.sessionId) throw new Error('A session is already open');
    if (mode !== 'guarded' && mode !== 'plan') throw new Error('Bridge supports guarded or plan mode only');
    const workspace = { workspacePath: this.cwd, workspaceKey: this.cwd };
    const snapshot = await this.request(resumeSessionId ? 'session/resume' : 'session/create', {
      workspace, ...(resumeSessionId ? { sessionId: resumeSessionId } : { mode }),
      ...(!resumeSessionId && model ? { model } : {}), ...(thoughtLevel ? { thoughtLevel } : {}),
    });
    if (snapshot?.protocol?.name !== 'ZCode Protocol' || snapshot.protocol.version !== 1 || !snapshot.session?.sessionId) {
      throw new Error('Unsupported ZCode app-server protocol; expected ZCode Protocol 1');
    }
    this.sessionId = snapshot.session.sessionId;
    // Resumed sessions retain their former permissions: explicitly restore our mode.
    if (resumeSessionId) {
      await this.request('session/setMode', { sessionId: this.sessionId, mode });
      if (model) await this.request('session/setModel', { sessionId: this.sessionId, model, persistAsWorkspaceLastUsed: false });
    }
    await this.request('session/subscribe', { sessionId: this.sessionId, deliveryKind: 'desktop-continuous', includeSnapshot: false });
    return snapshot;
  }

  async send(content, { signal } = {}) {
    if (!this.sessionId) throw new Error('Start a runtime session first');
    if (this.turn) throw new Error('A turn is already running');
    if (signal?.aborted) throw signal.reason ?? new Error('Turn cancelled');
    const inputId = randomUUID();
    let resolveTurn, rejectTurn;
    const done = new Promise((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
    // Attach a rejection observer immediately (completion can precede send ACK).
    done.catch(() => {});
    const onAbort = () => { void this.stop().catch(error => this._settleTurn(error)); };
    this.turn = { inputId, resolve: resolveTurn, reject: rejectTurn,
      cleanup: () => signal?.removeEventListener('abort', onAbort) };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await this.request('session/send', { sessionId: this.sessionId, inputId, queryId: inputId, content });
      if (signal?.aborted) onAbort();
    } catch (error) { this._settleTurn(error); }
    return done;
  }

  stop() {
    if (!this.sessionId) return Promise.resolve();
    if (this.stopPromise) return this.stopPromise;
    // A stop acknowledgement is not a terminal turn event. Bound the whole
    // cancellation window, including an absent acknowledgement or final event.
    if (this.turn && !this.cancelTimer) {
      this.cancelTimer = setTimeout(() => this._fail(new Error('ZCode runtime cancellation timed out')), this.cancellationTimeoutMs);
    }
    this.stopPromise = this.request('session/stop', { sessionId: this.sessionId });
    return this.stopPromise;
  }

  _settleTurn(error, value) {
    const turn = this.turn;
    if (!turn) return;
    this.turn = undefined;
    clearTimeout(this.cancelTimer);
    this.cancelTimer = undefined;
    this.stopPromise = undefined;
    turn.cleanup();
    if (error) turn.reject(error); else turn.resolve(value);
  }

  _terminate() {
    if (!this.child || (this.childClosed && !this.groupPid) || this.terminating) return;
    this.terminating = true;
    // Never issue session/close: that deletes stored history in this runtime.
    if (!this.childClosed) this.child.stdin.end();
    // Schedule escalation before kill, since test doubles and failed children
    // can synchronously report close from kill(). Keep the timer referenced.
    this.killTimer = setTimeout(() => {
      this._signalChild('SIGKILL');
    }, this.shutdownTimeoutMs);
    this._signalChild('SIGTERM');
  }

  _signalChild(signal) {
    if (this.groupPid) {
      try { process.kill(-this.groupPid, signal); } catch (error) {
        if (error.code !== 'ESRCH') this.emit('diagnostic', 'Unable to terminate runtime process group');
      }
    } else if (!this.childClosed) this.child.kill(signal);
  }

  _fail(error) {
    const wasClosed = this.closed;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this._settleTurn(error);
    this._terminate();
    if (!wasClosed) this.emit('disconnected', error);
  }

  close() {
    this._fail(new Error('Runtime bridge closed'));
  }
}
