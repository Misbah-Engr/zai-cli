import test from 'node:test';
import assert from 'node:assert/strict';
import {RuntimeDiagnostics, redactRuntimeDiagnostic} from '../src/runtime-diagnostics.mjs';

test('runtime diagnostics redact credentials, URLs and terminal controls before truncation', () => {
  const env = {ZAI_API_KEY: 'tiny-secret', OTHER_TOKEN: 'with spaces'};
  const lines = [
    'Error: tiny-secret', 'Error: with spaces',
    'Authorization: Bearer abc xyz', 'password="short words" trailing',
    'access_token=short', 'token: short',
    'fetch https://user:pass@example.org/path?code=secret#fragment failed',
    'secret sk-private-value', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzb21lb25lIn0.signature',
    '\x1b]0;unsafe title\x07\x1b[31mError: missing module\x1b[0m\u202e'
  ];
  const safe = lines.map(line => redactRuntimeDiagnostic(line, env)).join('\n');
  assert.doesNotMatch(safe, /tiny-secret|with spaces|abc|short|user:pass|example.org|code=secret|sk-private|eyJ|unsafe title|\x1b|\u202e/);
  assert.match(safe, /Error: missing module/);
});
test('buffers split secrets and UTF-8 until complete records and handles final partial record', () => {
  const emitted = [];
  const d = new RuntimeDiagnostics({env: {API_KEY: 'secret value'}, onLine: line => emitted.push(line)});
  d.write(Buffer.from('Error: secret'));
  assert.equal(emitted.length, 0);
  d.write(Buffer.from(' value\nError: unsupported command app-server'));
  assert.deepEqual(emitted, ['Error: [redacted]']);
  d.flush();
  assert.equal(d.last(), 'Error: unsupported command app-server');
});
test('oversized records are omitted wholesale, memory and records stay bounded', () => {
  const d = new RuntimeDiagnostics({maxLineBytes: 64, maxLines: 3, maxBytes: 120});
  d.write('Error: password=' + 'x'.repeat(1_000_000));
  assert.equal(d.pending, '');
  d.write('secret-tail\nError: Cannot find module example\n');
  assert.doesNotMatch(d.lines.join('\n'), /secret-tail|xxx/);
  assert.match(d.lines[0], /omitted/);
  for (let i = 0; i < 100; i++) d.write(`Error: missing module ${i}\n`);
  assert.ok(d.lines.length <= 3);
  assert.ok(d.bytes <= 120);
  assert.equal(d.last(), 'Error: missing module 99');
});
test('selects actionable failure above stack trace and version footer', () => {
  const d = new RuntimeDiagnostics();
  d.write("Error: Cannot find module 'zcode-app-cli'\n    at Function._resolveFilename (node:internal/modules/cjs/loader:1)\nNode.js v22.19.0\n");
  assert.equal(d.last(), "Error: Cannot find module 'zcode-app-cli'");
});
test('private key blocks and values following credential-only labels stay hidden', () => {
  const d = new RuntimeDiagnostics();
  d.write('-----BEGIN PRIVATE KEY-----\nshort-key-content\n-----END PRIVATE KEY-----\nAuthorization:\nBasic tiny-value\nError: unknown command\n');
  assert.doesNotMatch(d.lines.join('\n'), /short-key-content|tiny-value|PRIVATE KEY/);
  assert.equal(d.last(), 'Error: unknown command');
});
