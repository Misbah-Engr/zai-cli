import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clean, width, wrap, wrapWords, truncate, graphemes, writeJson, readJson, delay, redact } from '../src/util.mjs';
import { validateConfig, DEFAULTS, parseRuntimeCommand } from '../src/config.mjs';

test('terminal control sequences and clipboard OSC payloads are removed', () => {
  assert.equal(clean('\x1b[31mhello\x1b[0m\x1b]52;c;secret\x07!'), 'hello!');
  assert.equal(clean('a\x1b[2Jb\x00\u202ec'), 'abc');
  assert.equal(clean('a\r\nb\tc'), 'a\nb    c');
});
test('grapheme cells preserve emoji, accents, and CJK', () => {
  assert.equal(graphemes('e\u0301👩‍💻你').length, 3);
  assert.equal(width('e\u0301👩‍💻你'), 5);
  assert.deepEqual(wrap('你好hello', 4), ['你好', 'hell', 'o']);
  assert.equal(truncate('你好hello', 5), '你好…');
});
test('atomic config writes are readable and malformed JSON is not overwritten', async t => {
  const root = await mkdtemp(join(tmpdir(), 'zc-util-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'a', 'config.json');
  await writeJson(path, { value: 1 }); assert.deepEqual(await readJson(path), { value: 1 });
  await writeFile(path, '{ broken'); await assert.rejects(readJson(path), /Invalid JSON/);
  assert.equal(await readFile(path, 'utf8'), '{ broken');
  assert.deepEqual(await readJson(join(root, 'none'), { default: true }), { default: true });
});
test('configuration rejects insecure endpoints and unexpected fields', () => {
  for (const endpoint of ['http://api.z.ai/v4', 'https://user:pass@api.z.ai/v4', 'https://api.z.ai/v4?key=x', 'file:///tmp/x']) {
    assert.throws(() => validateConfig({ endpoint }), /HTTPS|endpoint/);
  }
  assert.throws(() => validateConfig({ apiKey: 'not-stored' }), /Unknown configuration/);
  assert.throws(() => validateConfig({ runtime: { command: 'zcode', args: 'x' } }), /array/);
  assert.throws(() => validateConfig({ mode: 'yolo' }), /mode/);
  assert.throws(() => validateConfig({ maxSteps: 0 }), /maxSteps/);
  assert.equal(validateConfig({}).endpoint, DEFAULTS.endpoint);
});
test('runtime JavaScript selection uses an argument array, never shell parsing', () => {
  const path = join(tmpdir(), 'my runtime', 'zcode.cjs');
  assert.deepEqual(parseRuntimeCommand(path), { command: process.execPath, args: [path] });
  assert.throws(() => parseRuntimeCommand('relative/zcode.cjs'), /absolute/);
});
test('known API keys are redacted without exposing bearer credentials', () => {
  const previous = process.env.ZAI_API_KEY; process.env.ZAI_API_KEY = 'test-key-not-a-secret';
  assert.equal(redact('key=test-key-not-a-secret Bearer abcdef'), 'key=[REDACTED] Bearer [REDACTED]');
  if (previous === undefined) delete process.env.ZAI_API_KEY; else process.env.ZAI_API_KEY = previous;
});
test('abortable delays reject promptly', async () => {
  const controller = new AbortController(); const pending = delay(20000, controller.signal); controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('prose wraps at words while long identifiers and wide characters remain bounded', () => {
  assert.deepEqual(wrapWords('alpha beta gamma', 10), ['alpha beta', 'gamma']);
  assert.deepEqual(wrapWords('abcdefghijk', 4), ['abcd', 'efgh', 'ijk']);
  const rows = wrapWords('你好 world code', 7);
  assert.ok(rows.every(row => width(row) <= 7));
  assert.equal(rows.join('').replaceAll(' ', ''), '你好worldcode');
});
