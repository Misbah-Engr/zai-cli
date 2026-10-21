import test from 'node:test';
import assert from 'node:assert/strict';
import { Editor, KeyDecoder, layoutEditor, indexAtPosition } from '../src/ui/input.mjs';
import { TerminalApp } from '../src/ui/app.mjs';
import { renderFrame, THEMES, transcriptRows } from '../src/ui/render.mjs';
import { validateConfig } from '../src/config.mjs';
import { width } from '../src/util.mjs';
import { PassThrough } from 'node:stream';
function app() { const a = new TerminalApp({ cwd: '/workspace/fixture', config: validateConfig({ theme: 'light' }), output: new PassThrough(), demo: true }); a.schedule = () => {}; return a; }
test('Ctrl+A selection replaces or deletes a complete multiline prompt and undo restores it', () => {
  const e = new Editor(); e.set('first\nsecond 🦁 line'); e.key('select-all'); assert.equal(e.selectedText, e.text);
  e.key('backspace'); assert.equal(e.text, ''); e.key('undo'); assert.equal(e.text, 'first\nsecond 🦁 line');
  e.key('select-all'); e.insert('replacement'); assert.equal(e.text, 'replacement'); e.key('undo'); assert.match(e.text, /🦁/); e.key('redo'); assert.equal(e.text, 'replacement');
});
test('arrow keys never replace a draft with historical prompts', () => {
  const e = new Editor(); e.set('old task'); e.remember(); e.set('unfinished draft');
  for (let i = 0; i < 50; i++) { e.key('up', 40); e.key('down', 40); }
  assert.equal(e.text, 'unfinished draft'); e.key('history-prev'); assert.equal(e.text, 'old task'); e.key('history-next'); assert.equal(e.text, 'unfinished draft');
});
test('SGR mouse sequences decode across every byte split without text injection', () => {
  const sequence = '\x1b[<0;27;19M';
  for (let split = 1; split < sequence.length; split++) {
    const events = [], decoder = new KeyDecoder(e => events.push(e)); decoder.feed(sequence.slice(0, split)); if (split > 1) decoder.flush(); decoder.feed(sequence.slice(split));
    assert.deepEqual(events, [{ mouse: { x: 26, y: 18, button: 0, shift: false, alt: false, ctrl: false, action: 'press' } }]);
  }
});
test('mouse wheel events are distinct from Up/Down keys', () => {
  const events = [], d = new KeyDecoder(e => events.push(e)); d.feed('\x1b[<64;10;10M\x1b[<65;10;10M');
  assert.deepEqual(events.map(e => e.mouse.action), ['wheel-up', 'wheel-down']); assert.ok(events.every(e => !e.key && !e.text));
});
test('click places caret and drag selects only the desired range', () => {
  const a = app(); a.editor.set('alpha beta gamma'); renderFrame(a, 100, 30, true); const c = a.composer;
  a.handleMouse({ action: 'press', button: 0, x: c.x + 6, y: c.y }); assert.equal(a.editor.cursor, 6);
  a.handleMouse({ action: 'drag', button: 0, x: c.x + 10, y: c.y }); assert.equal(a.editor.selectedText, 'beta');
  a.handleMouse({ action: 'release', button: 0, x: c.x + 10, y: c.y }); a.handleKey({ key: 'backspace' }); assert.equal(a.editor.text, 'alpha  gamma');
});
test('wheel scrolling preserves an unsent draft and its caret', () => {
  const a = app(); a.editor.set('Do not lose this'); a.editor.cursor = 5; a.editor.history.push('old dangerous prompt');
  for (let i = 0; i < 40; i++) a.state.apply({ type: 'message', role: 'assistant', id: String(i), text: 'Line ' + i });
  renderFrame(a, 100, 30, true); a.handleMouse({ action: 'wheel-up', x: 2, y: 4 });
  assert.equal(a.editor.text, 'Do not lose this'); assert.equal(a.editor.cursor, 5); assert.ok(a.scroll > 0);
});
test('wrapped-row hit testing handles wide graphemes and row-end caret', () => {
  const e = new Editor(); e.set('abcde你好🦁tail'); const l = layoutEditor(e, 5);
  assert.equal(indexAtPosition(l, 0, 5), 5); assert.equal(indexAtPosition(l, 1, 0), 5);
  e.key('select-left'); assert.equal(e.selectedText, 'l');
});
test('all ordinary text roles meet 4.5:1 palette contrast on explicit backgrounds', () => {
  const lum = rgb => rgb.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
  for (const name of ['light', 'dark']) {
    const theme = THEMES[name], bg = lum(theme.background.split(';').slice(2).map(Number));
    for (const [role, value] of Object.entries(theme)) {
      if (role === 'background') continue; const fg = lum(value.split(';').slice(2).map(Number)); const contrast = (Math.max(bg, fg) + .05) / (Math.min(bg, fg) + .05);
      assert.ok(contrast >= 4.5, `${name}.${role} has ${contrast.toFixed(2)}:1`);
    }
  }
});
test('light and dark frame widths remain within 36, 60, 80, 120, and 200 columns', () => {
  for (const theme of ['light', 'dark', 'mono', 'auto']) for (const columns of [36, 60, 80, 120, 200]) {
    const a = app(); a.config.theme = theme; a.editor.set('Fix the tests.\n🦁 '.repeat(20)); a.editor.key('select-left');
    a.state.apply({ type: 'message', role: 'assistant', text: '# Heading\nReadable **strong text**, `inline code` and a long path /really/long/path.\n| File | Status |\n| --- | --- |\n| src/index.ts | Reviewed |' });
    const f = renderFrame(a, columns, 30, true); assert.equal(f.lines.length, 30);
    assert.ok(f.lines.every(line => width(line) < columns), `${theme} ${columns}`);
    assert.ok(f.cursor.row <= 30 && f.cursor.column < columns);
  }
});
test('Markdown tables and emphasis are rendered, not left as raw syntax', () => {
  const rows = transcriptRows([{ id: '1', role: 'assistant', text: '# Results\n**All tests passed.**\n| File | Result |\n| --- | --- |\n| core.mjs | Passed |' }], 80, false, new Map());
  const text = rows.map(r => r.text).join('\n'); assert.doesNotMatch(text, /\*\*|\| File|# Results/); assert.match(text, /core.mjs/);
});
test('draft saves even if the transcript archive reports an I/O failure on close', async t => {
  const { mkdtemp, rm, readFile } = await import('node:fs/promises'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'zc-draft-close-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const a = app(); a.draftPath = join(dir, 'draft.json'); a.editor.set('Keep this unsent request.'); a.journal = { close: async () => { throw new Error('disk fixture'); } };
  a.input = { off() {}, setRawMode() {}, pause() {} }; a.onData = a.onInputEnd = a.onResize = a.onOutputError = a.onTerm = a.onInt = () => {};
  await a.close(); assert.equal(JSON.parse(await readFile(a.draftPath, 'utf8')).text, 'Keep this unsent request.'); assert.equal(a.exitCode, 1);
});
