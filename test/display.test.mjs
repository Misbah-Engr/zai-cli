import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {clean} from '../src/display.mjs';
test('display neutralizes terminal and bidi controls without hiding their location', () => {
  assert.equal(clean('run \u202eevil\u202c'), 'run \\u202eevil\\u202c');
  assert.equal(clean('a\u2066b\u2069'), 'a\\u2066b\\u2069');
  assert.equal(clean('\x1b[31mhello\x07'), '[31mhello');
  assert.equal(clean('hello\nworld\t✓'), 'hello\nworld\t✓');
});
test('spinner and erase sequences are disabled with plain/color-off rendering', async () => {
  const source = await readFile(new URL('../src/cli.mjs', import.meta.url), 'utf8');
  assert.match(source, /const spinner = color \?/);
  assert.match(source, /if \(waiting && color\)/);
});
