import { StringDecoder } from 'node:string_decoder';
import { bounded, id, isRecord, redact } from '../util.mjs';
import { parseNativeModel } from './native-contract.mjs';

// Preferred client contains upstream's shared-OAuth token-contract repair.
export const STREAM_CLIENT_VERSION = '3.15.3-37';
export const STREAM_CLIENT_VERSIONS = Object.freeze(['3.15.3-36', STREAM_CLIENT_VERSION]);
export const STREAM_RUNTIME_VERSION = '0.16.9';
/** Identify an explicitly supported pair, not arbitrary version-like substrings. */
export function streamVersionIdentity(output) {
  if (typeof output !== 'string' || Buffer.byteLength(output) > 2000) return undefined;
  const lines = output.split(/\r?\n/);
  const clients = lines.filter(line => line.startsWith('zcode-app-cli '));
  const runtimes = lines.filter(line => line.startsWith('zcode-runtime '));
  if (clients.length !== 1 || runtimes.length !== 1) return undefined;
  const client = clients[0].slice('zcode-app-cli '.length);
  const runtime = runtimes[0].slice('zcode-runtime '.length);
  if (!STREAM_CLIENT_VERSIONS.includes(client) || runtime !== STREAM_RUNTIME_VERSION) return undefined;
  return { client, runtime };
}

// Same exclusions as the user's successful smoke test. This is not an allowlist or sandbox.
export const STREAM_DENIED_TOOLS = Object.freeze([
  'Bash', 'Write', 'Edit', 'NotebookEdit', 'Task', 'Agent', 'CreateWorkflow', 'AmendWorkflow',
]);
export const STREAM_POLICY = 'guarded-research-v1';
export const STREAM_NOTICE = 'Experimental native stream: existing ZCode login, guarded runtime policy, common write/shell/agent tools excluded. Other runtime tools or plugins may still have side effects. ZC cannot display or grant headless tool approvals. Not strict read-only and not an OS sandbox.';
const SESSION_ID = /^sess_[A-Za-z0-9_-]{1,180}$/;
export function validStreamSession(value) { return typeof value === 'string' && SESSION_ID.test(value); }
export function streamModel(value) {
  const parsed = parseNativeModel(value);
  if (parsed.options) throw new Error('Native stream uses the runtime reasoning default. Supply providerId/modelId without a reasoning suffix.');
  return value;
}
export function streamArguments({ model, text, sessionId }) {
  streamModel(model);
  if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 24000 || text.includes('\0')) {
    throw new Error('Native stream needs a nonempty prompt of at most 24,000 UTF-8 bytes, with no NUL characters.');
  }
  // The upstream headless CLI expands slash commands, including custom command hooks.
  if (text.trimStart().startsWith('/')) throw new Error('Native stream does not forward slash commands. Use ZC commands locally or the original client.');
  if (sessionId !== undefined && !validStreamSession(sessionId)) throw new Error('Invalid upstream session identifier.');
  return ['--model', model, '--mode', 'guarded', '--disallowedTools', STREAM_DENIED_TOOLS.join(','),
    '--output-format', 'stream-json', ...(sessionId ? ['--resume', sessionId] : []), '--prompt', text];
}

/** No input is interpreted as shell text. Diagnostic details are never reflected. */
export function streamErrorMessage(text) {
  if (text.includes('project_token_login_failed')) return 'ZCode token exchange failed (project_token_login_failed). This does not prove your login expired. No login or retry was attempted by ZC. Check the upstream client version and docs/AUTH-RECOVERY.md before repeating authorization.';
  if (text.includes('project_token_login_required')) return 'ZCode requires account login (project_token_login_required). Authenticate in the original zcode client. No input was automatically replayed.';
  if (text.includes('Model access is not configured')) return 'ZCode reports that model access is not configured. Check the exact provider/model selection and sign in through the original zcode client.';
  if (text.includes('Select a model before continuing')) return 'ZCode did not accept the selected model. Choose an exact provider/model reference that works in the original client.';
  if (/Unknown option|Unsupported --mode|unknown.*--model/i.test(text)) return 'The installed ZCode client rejected the stream flags. Check its version; ZC did not fall back to another backend or permission mode.';
  return undefined;
}

/** Bounded NDJSON transport. A newline may split at any UTF-8 byte boundary. */
export class StreamDecoder {
  constructor(onFrame, { maxFrameBytes = 2 * 1024 * 1024, maxBytes = 64 * 1024 * 1024, maxFrames = 100000 } = {}) {
    this.onFrame = onFrame; this.maxFrameBytes = maxFrameBytes; this.maxBytes = maxBytes; this.maxFrames = maxFrames;
    this.decoder = new StringDecoder('utf8'); this.buffer = ''; this.bytes = 0; this.frames = 0; this.ended = false;
  }
  feed(chunk) {
    if (this.ended) throw new Error('Data arrived after stream termination.');
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.bytes += bytes.length;
    if (this.bytes > this.maxBytes) throw new Error('ZCode stream exceeded the turn byte limit. No input was replayed.');
    this.consume(this.decoder.write(bytes));
  }
  consume(text) {
    this.buffer += text;
    let end;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1); this.line(line);
    }
    if (Buffer.byteLength(this.buffer) > this.maxFrameBytes) throw new Error('ZCode stream frame exceeded the byte limit.');
  }
  line(line) {
    if (Buffer.byteLength(line) > this.maxFrameBytes) throw new Error('ZCode stream frame exceeded the byte limit.');
    if (!line.trim()) return;
    if (++this.frames > this.maxFrames) throw new Error('ZCode stream exceeded the event limit.');
    let frame;
    try { frame = JSON.parse(line); } catch { throw new Error('ZCode stdout was not valid NDJSON. Raw output was withheld.'); }
    if (!isRecord(frame) || typeof frame.type !== 'string' || frame.type.length > 256) throw new Error('Invalid ZCode stream envelope.');
    this.onFrame(frame);
  }
  end() {
    if (this.ended) return;
    this.consume(this.decoder.end()); this.ended = true;
    if (this.buffer.trim()) this.line(this.buffer);
    this.buffer = '';
  }
}

/** Project only the small display surface; never forward session.updated diagnostics. */
export class StreamTurn {
  constructor({ emit, expectedSession, onSession = () => {} }) {
    this.emit = emit; this.sessionId = expectedSession; this.onSession = onSession;
    this.seq = -1; this.texts = new Map(); this.tools = new Map(); this.assistantId = undefined;
    this.completed = undefined; this.result = undefined; this.failed = false;
  }
  bindSession(value) {
    if (!validStreamSession(value)) throw new Error('Invalid session ID in ZCode stream.');
    if (this.sessionId && value !== this.sessionId) throw new Error('ZCode returned a different session than the one requested.');
    if (!this.sessionId) { this.sessionId = value; this.onSession(value); }
  }
  frame(frame) {
    if (this.result) throw new Error('ZCode emitted a frame after its final result.');
    if (frame.type === 'result') {
      this.bindSession(frame.sessionId);
      if (!this.completed || this.failed || frame.turnId !== this.turnId || typeof frame.response !== 'string' || frame.response !== this.completed.response) {
        throw new Error('ZCode result did not match a successful completed turn.');
      }
      if (frame.projection?.status !== 'idle') throw new Error('ZCode result did not confirm an idle runtime.');
      this.result = { response: frame.response, sessionId: frame.sessionId, turnId: frame.turnId, usage: safeUsage(frame.usage) };
      return;
    }
    // Foreign child-session observations must not complete or corrupt the main turn.
    if (this.sessionId && frame.sessionId !== this.sessionId) return;
    this.bindSession(frame.sessionId);
    if (!Number.isSafeInteger(frame.seq) || frame.seq < 0) throw new Error('Invalid sequence number in ZCode stream.');
    if (frame.seq <= this.seq) return;
    this.seq = frame.seq;
    const p = isRecord(frame.payload) ? frame.payload : {};
    if (frame.type === 'turn.started') {
      if (this.turnId) throw new Error('Unexpected additional headless turn. ZC has not enabled workflow execution.');
      if (typeof frame.turnId !== 'string' || !frame.turnId || frame.turnId.length > 256) throw new Error('Missing turn identity in ZCode stream.');
      this.turnId = frame.turnId;
    }
    if (!this.turnId || frame.turnId !== this.turnId) return;
    if (this.completed) throw new Error('ZCode emitted turn data after completing that turn.');
    if (frame.type === 'model.streaming') {
      if (p.kind === 'reasoning_start') this.emit({ type: 'status', phase: 'working', detail: 'Thinking' });
      if (p.kind === 'text_start') this.assistantId = this.messageId(p);
      if (p.kind === 'text_delta') {
        if (typeof p.delta !== 'string') throw new Error('Invalid text delta in ZCode stream.');
        this.assistantId = this.messageId(p);
        if (this.texts.size >= 128 && !this.texts.has(this.assistantId)) throw new Error('ZCode exceeded the assistant-message limit.');
        const text = (this.texts.get(this.assistantId) || '') + p.delta;
        if (text.length > 120000) throw new Error('ZCode exceeded the display-message limit.');
        this.texts.set(this.assistantId, text);
        this.emit({ type: 'delta', id: this.assistantId, text: p.delta });
      }
      if (p.kind === 'tool_call' && typeof p.toolCallId === 'string') {
        this.rememberTool(p.toolCallId, p.toolName, p.input);
      }
    }
    if (frame.type === 'tool.updated' && typeof p.toolCallId === 'string') {
      const tool = this.rememberTool(p.toolCallId, p.toolName, p.input);
      const status = { scheduled: 'queued', started: 'running', progress: 'running', result: 'done', error: 'error' }[p.kind];
      if (status) this.emit({ type: 'tool', id: `stream-tool:${p.toolCallId}`, name: tool.name, input: tool.input, status,
        ...(p.kind === 'result' ? { output: display(p.result) } : {}),
        ...(p.kind === 'error' ? { output: 'The runtime reported a tool error. Inspect the original client for details.' } : {}),
        ...(typeof p.duration === 'number' && Number.isFinite(p.duration) ? { duration: p.duration } : {}) });
    }
    if (frame.type === 'permission.requested' || frame.type === 'userInput.requested') {
      this.emit({ type: 'notice', text: 'ZCode requested an interaction that this headless backend cannot approve. No Allow response was sent. Use the original interactive client for approval-dependent work.' });
    }
    if (frame.type === 'turn.failed') {
      this.failed = true;
      throw new Error(streamErrorMessage(typeof p.error?.message === 'string' ? p.error.message : '') || 'The ZCode runtime reported a failed turn. Raw exception and authentication diagnostics were withheld.');
    }
    if (frame.type === 'turn.completed') {
      if (p.resultType !== 'success') { this.failed = true; throw new Error(`ZCode did not complete successfully (${['cancelled', 'error_max_turns', 'error_max_budget', 'error_during_execution', 'error_max_tool_calls'].includes(p.resultType) ? p.resultType : 'runtime failure'}).`); }
      if (typeof p.response !== 'string') throw new Error('Missing final text in ZCode completed turn.');
      this.completed = { response: p.response };
      this.emit({ type: 'message', id: this.assistantId || `stream-answer:${id()}`, role: 'assistant', text: p.response });
      const usage = safeUsage(p.usage); if (usage) this.emit({ type: 'usage', usage });
    }
  }
  messageId(p) {
    for (const key of ['assistantMessageId', 'partId']) if (p[key] !== undefined && (typeof p[key] !== 'string' || p[key].length > 256)) throw new Error('Invalid assistant identifier in stream.');
    return `stream-text:${typeof p.assistantMessageId === 'string' ? p.assistantMessageId : typeof p.partId === 'string' ? p.partId : this.assistantId?.replace(/^stream-text:/, '') || id()}`;
  }
  rememberTool(key, name, input) {
    if (key.length > 256) throw new Error('Oversized tool identifier.');
    if (this.tools.size >= 512 && !this.tools.has(key)) throw new Error('ZCode exceeded the tool display limit.');
    const old = this.tools.get(key) || {};
    const tool = { ...old, ...(typeof name === 'string' ? { name: bounded(name, 256) } : {}), ...(input !== undefined ? { input: display(input) } : {}) };
    this.tools.set(key, tool); return tool;
  }
  finish() {
    if (!this.result || !this.completed || this.failed) throw new Error('ZCode exited without a verified final result. The turn may be incomplete; no input was replayed.');
    return this.result;
  }
}
function display(value) { return bounded(redact(typeof value === 'string' ? value : JSON.stringify(value) || ''), 24000); }
export function safeUsage(value) {
  if (!isRecord(value)) return undefined;
  const safe = {};
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'modelRequestCount']) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0) safe[key] = value[key];
  }
  return Object.keys(safe).length ? safe : undefined;
}
