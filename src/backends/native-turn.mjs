import { hash, isRecord } from '../util.mjs';

/** Correlates a single submitted root turn without confusing background/subagent turns. */
export class NativeTurn {
  constructor({ inputId, text, afterSeq, signal, rpc, sessionId, emit, complete, intervalMs, probeTimeoutMs = 15000 }) {
    Object.assign(this, { inputId, signal, rpc, sessionId, emit, complete, intervalMs, probeTimeoutMs });
    this.textHash = hash(text); this.afterSeq = afterSeq; this.recoverySeq = afterSeq; this.turnId = null;
    this.started = false; this.closed = false; this.probing = false; this.waitingForApproval = 0;
    this.accepted = false; this.failures = 0; this.silentSince = Date.now(); this.timer = null;
    this.touch();
  }
  acceptsStart(event) {
    if (event.sessionId !== this.sessionId || event.seq <= this.afterSeq) return false;
    const p = event.payload || {};
    if (p.inputId !== undefined) return p.inputId === this.inputId;
    if (p.queryId !== undefined) return p.queryId === this.inputId;
    // Some legacy v1 builds omit both IDs. Require the exact submitted root input.
    if (p.inputSource && !['user', 'real_user'].includes(p.inputSource)) return false;
    if (p.inputVisibility === 'model-only' || p.backgroundSource || p.originMeta?.kind === 'subagent') return false;
    return typeof p.input === 'string' && hash(p.input) === this.textHash;
  }
  observe(event) {
    if (this.closed || event.sessionId !== this.sessionId || event.seq <= this.afterSeq) return false;
    if (event.type === 'turn.started' && this.acceptsStart(event)) {
      this.started = true; this.accepted = true; this.turnId = event.turnId || this.turnId;
    }
    return this.matches(event);
  }
  matches(event) {
    if (this.closed || event.sessionId !== this.sessionId || event.seq <= this.afterSeq) return false;
    const p = event.payload || {};
    if (p.inputId !== undefined) return p.inputId === this.inputId;
    if (p.queryId !== undefined) return p.queryId === this.inputId;
    return Boolean(this.turnId && event.turnId === this.turnId);
  }
  touch() {
    if (this.closed) return;
    this.silentSince = Date.now(); this.failures = 0; clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.probe(); }, this.intervalMs);
  }
  rearm() {
    if (this.closed) return;
    clearTimeout(this.timer); this.timer = setTimeout(() => { void this.probe(); }, this.intervalMs);
  }
  close() { this.closed = true; clearTimeout(this.timer); }
  async probe() {
    if (this.closed || this.probing) return;
    if (this.waitingForApproval) {
      this.emit({ type: 'status', phase: 'waiting', detail: 'Waiting for your approval' }); this.rearm(); return;
    }
    this.probing = true;
    this.emit({ type: 'status', phase: 'checking', detail: 'Quiet runtime. Checking session state; no task has been stopped.' });
    try {
      const snapshot = await this.rpc.request('session/read', { sessionId: this.sessionId }, { timeoutMs: this.probeTimeoutMs });
      if (this.closed) return;
      if (!isRecord(snapshot) || snapshot.session?.sessionId !== this.sessionId) throw new Error('Unexpected session state during connection check.');
      this.failures = 0;
      // Read bounded pages, not only the first 1,000 records of a long-running turn.
      // A continuation cursor is retained across probes; no prompt is resent.
      let recoveryComplete = false;
      try {
        for (let page = 0; page < 8; page++) {
          const result = await this.rpc.request('session/events', { sessionId: this.sessionId, afterSeq: this.recoverySeq, limit: 1000 }, { timeoutMs: this.probeTimeoutMs });
          if (this.closed) return;
          if (!Array.isArray(result?.events)) break;
          const events = result.events.filter(event => event.sessionId === this.sessionId && Number.isSafeInteger(event.seq) && event.seq > this.recoverySeq).sort((a, b) => a.seq - b.seq);
          for (const event of events) {
            this.observe(event); this.recoverySeq = Math.max(this.recoverySeq, event.seq);
            if (this.matches(event) && ['turn.completed', 'turn.failed'].includes(event.type)) { this.complete(event); return; }
          }
          if (result.events.length < 1000) { recoveryComplete = true; break; }
          if (!events.length) break;
        }
      } catch { /* A read-only events query may be unavailable; do not infer a failed task. */ }
      if (this.closed) return;
      const pending = snapshot.projection?.pendingPermissions;
      const running = snapshot.runtime?.mainActive === true || ['running', 'waiting'].includes(snapshot.session.status) || ['running', 'waiting'].includes(snapshot.projection?.status);
      if (running || (Array.isArray(pending) && pending.length)) {
        this.emit({ type: 'status', phase: pending?.length ? 'waiting' : 'working', detail: pending?.length ? 'Runtime is waiting for input or approval' : 'Runtime is active; waiting for its next update' });
      } else if (recoveryComplete && snapshot.runtime?.mainActive === false && ['idle', 'completed', 'error', 'paused'].includes(snapshot.session.status || snapshot.projection?.status)) {
        this.onUnconfirmed?.(new Error('Runtime is idle, but this turn has no matching completion record. Review /status and /reconnect. No task was stopped or replayed.'));
        return;
      } else this.emit({ type: 'status', phase: 'checking', detail: 'Runtime responds; task state is not yet confirmed. Esc stops the task.' });
    } catch (error) {
      if (this.closed) return;
      this.failures++;
      this.emit({ type: 'status', phase: 'uncertain', detail: `No health response (${this.failures}). Task may still be running. Esc stops; no prompt replay.` });
    } finally { this.probing = false; this.rearm(); }
  }
}
