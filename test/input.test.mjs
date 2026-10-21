import test from 'node:test';
import assert from 'node:assert/strict';
import { Editor, KeyDecoder, layoutEditor } from '../src/ui/input.mjs';

test('backspace removes one complete grapheme', () => {
  const editor = new Editor(); editor.insert('A👩‍💻e\u0301'); editor.key('backspace');
  assert.equal(editor.text, 'A👩‍💻'); editor.key('left'); editor.key('delete'); assert.equal(editor.text, 'A');
});
test('editor maintains logical multiline navigation', () => {
  const editor = new Editor(); editor.set('abc\nxy'); editor.key('up'); assert.equal(editor.cursor, 2);
  editor.key('end'); assert.equal(editor.cursor, 3); editor.key('down'); assert.equal(editor.cursor, 6);
  editor.key('home'); assert.equal(editor.cursor, 4); editor.key('newline'); assert.equal(editor.text, 'abc\n\nxy');
});
test('command history restores the unsent draft', () => {
  const editor = new Editor(); editor.set('first'); editor.remember(); editor.set('draft');
  editor.key('history-prev'); assert.equal(editor.text, 'first'); editor.key('history-next'); assert.equal(editor.text, 'draft');
});
test('fragmented bracketed paste cannot submit or trigger shortcuts', () => {
  const events = [], parser = new KeyDecoder(e => events.push(e));
  for (const piece of ['\x1b[2', '00~hello\r\n', 'rm -rf anything\x03', '\x1b[20', '1~']) parser.feed(piece);
  assert.deepEqual(events, [{ text: 'hello\nrm -rf anything' }]);
});
test('unbracketed multiline paste is inserted rather than executed', () => {
  const events = [], parser = new KeyDecoder(e => events.push(e)); parser.feed('hello\rworld\r');
  assert.deepEqual(events, [{ text: 'hello\nworld\n' }]);
});
test('escape sequences can arrive in separate chunks', () => {
  const events = [], parser = new KeyDecoder(e => events.push(e)); parser.feed('\x1b['); parser.feed('1;5D');
  parser.feed('\x1b'); parser.flush(); assert.deepEqual(events, [{ key: 'word-left' }, { key: 'escape' }]);
});
test('oversized paste is rejected as a whole', () => {
  const events = [], parser = new KeyDecoder(e => events.push(e)); parser.feed('\x1b[200~' + 'a'.repeat(65000) + '\x1b[201~');
  assert.deepEqual(events, [{ key: 'paste-overflow' }]);
});
test('cursor layout counts wide cells without splitting characters', () => {
  const editor = new Editor(); editor.set('你好abc');
  const layout = layoutEditor(editor, 5);
  assert.deepEqual(layout.rows, ['你好a', 'bc']); assert.deepEqual(layout.cursor, { row: 1, column: 2 });
});
