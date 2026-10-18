import {StringDecoder} from 'node:string_decoder';

const SECRET_NAME = /(?:key|token|secret|password|passwd|credential|authorization|cookie)/i;

// Runtime logs are untrusted. Redact complete records BEFORE truncation, including
// known inherited credentials. No credential store is read and nothing is saved.
export function redactRuntimeDiagnostic(value, env = process.env) {
  let text = String(value)
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[redacted credential]')
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '');
  for (const [name, value] of Object.entries(env)) {
    if (!SECRET_NAME.test(name) || !value) continue;
    for (const secret of [value, encodeURIComponent(value)]) text = text.split(secret).join('[redacted]');
  }
  text = text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi, '[redacted URL]')
    // Omit the remainder of credential-bearing records, including quoted values
    // with spaces and multiple headers. Short unstructured credentials are not
    // reliably distinguishable from prose; debug output still requires review.
    .replace(/\b(?:[\w-]*(?:api[ _-]?key|key|token|password|passwd|secret|credential|authorization|cookie)[\w-]*)["']?\s*[:=]\s*.*/gi, '[redacted credential]')
    .replace(/\b(?:Bearer|Basic)\s+.*/gi, '[redacted authorization]')
    .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/g, '[redacted token]')
    .replace(/\b(?:sk|key|token)[_-][A-Za-z0-9_.-]+/gi, '[redacted]')
    .replace(/[A-Za-z0-9_+\/=-]{24,}(?:\.[A-Za-z0-9_+\/=-]+)*/g, '[redacted]')
    .trim();
  return text.length > 1024 ? text.slice(0, 1024) + '…' : text;
}

export class RuntimeDiagnostics {
  constructor({env = process.env, maxLineBytes = 8192, maxLines = 32, maxBytes = 16 * 1024, onLine} = {}) {
    Object.assign(this, {env, maxLineBytes, maxLines, maxBytes, onLine});
    this.decoder = new StringDecoder('utf8');
    this.pending = '';
    this.discarding = false;
    this.lines = [];
    this.bytes = 0;
  }
  write(chunk) {
    const text = this.decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    // Walk boundaries without ever buffering an unbounded unterminated record.
    let start = 0;
    for (let i = 0; i <= text.length; i++) {
      if (i !== text.length && text[i] !== '\n' && text[i] !== '\r') continue;
      const part = text.slice(start, i);
      if (!this.discarding) {
        if (Buffer.byteLength(this.pending) + Buffer.byteLength(part) > this.maxLineBytes) {
          this.pending = '';
          this.discarding = true;
        } else this.pending += part;
      }
      if (i !== text.length) {
        this._record();
        start = i + 1;
      }
    }
  }
  _record() {
    const privateKey = /-----BEGIN [^-]*PRIVATE KEY-----/.test(this.pending);
    const suppress = privateKey || this.privateKey || this.credentialContinuation;
    this.privateKey = (privateKey || this.privateKey) && !/-----END [^-]*PRIVATE KEY-----/.test(this.pending);
    this.credentialContinuation = /\b(?:api[ _-]?key|token|password|secret|credential|authorization|cookie)[\"']?\s*[:=]\s*$/.test(this.pending);
    const safe = suppress ? '[redacted credential]' : this.discarding ? '[Oversized runtime diagnostic omitted]' : redactRuntimeDiagnostic(this.pending, this.env);
    this.pending = '';
    this.discarding = false;
    if (!safe) return;
    const line = safe.length > 1024 ? safe.slice(0, 1024) + '…' : safe;
    const bytes = Buffer.byteLength(line);
    this.lines.push(line);
    this.bytes += bytes;
    while (this.lines.length > this.maxLines || this.bytes > this.maxBytes) this.bytes -= Buffer.byteLength(this.lines.shift());
    this.onLine?.(line);
  }
  flush() {
    this.pending += this.decoder.end();
    this._record();
  }
  last() {
    // Stack frames and Node's version footer should not bury the actual cause.
    return this.lines.findLast(line => /\b(?:error|failed|cannot|could not|unknown|unsupported|unrecognized|invalid|missing|denied|not found)\b/i.test(line) && !/^at\s/.test(line))
      ?? this.lines.at(-1);
  }
}
