import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { id, isRecord, abortError, hash } from './util.mjs';

/** Bounded, bidirectional NDJSON RPC. This is not JSON-RPC 2.0. */
export class ProtocolClient extends EventEmitter {
  constructor(input, output, { onRequest, timeoutMs = 30000, maxFrameBytes = 8 * 1024 * 1024 } = {}) {
    super();
    this.input = input; this.output = output; this.onRequest = onRequest;
    this.timeoutMs = timeoutMs; this.maxFrameBytes = maxFrameBytes;
    this.decoder = new StringDecoder('utf8'); this.buffer = ''; this.pending = new Map();
    this.reverse = new Map(); this.closed = false;
    input.on('data', this.onData);
    input.once('end', this.onEnd);
    input.on('error', this.onError); output.on('error', this.onError);
  }
  onData = chunk => {
    if (this.closed) return;
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    let newline;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.decode(line);
      if (this.closed) return;
    }
    if (Buffer.byteLength(this.buffer) > this.maxFrameBytes) this.fail(new Error('Runtime frame exceeded the protocol byte limit.'));
  };
  onEnd = () => {
    this.buffer += this.decoder.end();
    if (this.buffer.trim()) this.decode(this.buffer.trim());
    this.fail(new Error('The ZCode runtime closed its connection. No request was replayed.'));
  };
  onError = error => this.fail(error);
  decode(line) {
    if (Buffer.byteLength(line) > this.maxFrameBytes) return this.fail(new Error('Oversized runtime frame.'));
    let frame;
    try { frame = JSON.parse(line); } catch { return this.fail(new Error('The runtime wrote non-JSON output to the protocol channel. Check its version and command.')); }
    if (!isRecord(frame) || Object.keys(frame).some(key => !['id', 'method', 'params', 'result', 'error', 'trace'].includes(key))) return this.fail(new Error('Invalid runtime protocol envelope.'));
    const hasId = Object.hasOwn(frame, 'id');
    if (hasId && !(typeof frame.id === 'string' || Number.isSafeInteger(frame.id))) return this.fail(new Error('Invalid runtime request ID.'));
    if (typeof frame.method === 'string' && frame.method && frame.method.length <= 256 && !('result' in frame) && !('error' in frame)) {
      if (hasId) void this.handleReverse(frame).catch(error => this.fail(error));
      else this.emit('notification', frame.method, frame.params);
    } else if (hasId && (('result' in frame) !== ('error' in frame)) && !('method' in frame)) {
      const pending = this.pending.get(frame.id);
      if (!pending) return; // A late answer to a timed-out request is not a new action.
      if ('error' in frame && (!isRecord(frame.error) || typeof frame.error.message !== 'string' || !Number.isInteger(frame.error.code))) return this.fail(new Error('Malformed runtime error.'));
      pending.finish(frame.error ? new Error(frame.error.message) : null, frame.result);
    } else this.fail(new Error('Malformed runtime protocol frame.'));
  }
  async handleReverse(frame) {
    if (this.reverse.has(frame.id)) {
      const saved = this.reverse.get(frame.id);
      if (saved.signature !== hash(JSON.stringify([frame.method, frame.params]))) return this.fail(new Error('Runtime reused a request ID for different content.'));
      if (saved.response) this.write(saved.response);
      return;
    }
    // Completed responses are cached, so permission reannouncements cannot create duplicate prompts.
    if (this.reverse.size >= 512) {
      const completed = [...this.reverse].find(([,entry]) => entry.response);
      if (completed) this.reverse.delete(completed[0]);
      else return this.fail(new Error('Too many pending runtime interactions.'));
    }
    const entry = { signature: hash(JSON.stringify([frame.method, frame.params])) }; this.reverse.set(frame.id, entry);
    try {
      if (!this.onRequest) throw Object.assign(new Error(`Unsupported runtime request: ${frame.method}`), { code: -32601 });
      entry.response = { id: frame.id, result: await this.onRequest(frame.method, frame.params) };
    } catch (error) {
      entry.response = { id: frame.id, error: { code: Number.isInteger(error.code) ? error.code : -32603, message: error.message || 'Request rejected.' } };
    }
    if (!this.closed) this.write(entry.response);
  }
  write(frame) {
    if (this.closed) throw new Error('Runtime connection is closed.');
    const encoded = JSON.stringify(frame) + '\n';
    if (Buffer.byteLength(encoded) > this.maxFrameBytes || this.output.writableLength > this.maxFrameBytes) throw new Error('Runtime write exceeded the byte limit.');
    try { this.output.write(encoded); } catch (error) { this.fail(error); throw error; }
  }
  request(method, params = {}, { signal, timeoutMs = this.timeoutMs } = {}) {
    if (this.closed) return Promise.reject(new Error('Runtime connection is closed.'));
    if (signal?.aborted) return Promise.reject(abortError());
    if (this.pending.size >= 64) return Promise.reject(new Error('Too many pending runtime requests.'));
    return new Promise((resolve, reject) => {
      const requestId = id();
      const finish = (error, result) => {
        if (!this.pending.delete(requestId)) return;
        clearTimeout(timer); signal?.removeEventListener('abort', cancel);
        error ? reject(error) : resolve(result);
      };
      const cancel = () => finish(abortError());
      const timer = setTimeout(() => finish(Object.assign(new Error(`${method} timed out. It may have been accepted; the request was not replayed.`), { code: 'RPC_TIMEOUT' })), timeoutMs);
      this.pending.set(requestId, { finish });
      signal?.addEventListener('abort', cancel, { once: true });
      try { this.write({ id: requestId, method, params }); } catch (error) { finish(error); }
    });
  }
  fail(error) {
    if (this.closed) return;
    this.closed = true;
    this.input.off('data', this.onData);
    for (const pending of [...this.pending.values()]) pending.finish(error);
    this.emit('fault', error);
  }
  close() { this.fail(new Error('Runtime connection closed.')); }
}
