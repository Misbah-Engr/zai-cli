import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { renderFrame, Screen } from '../src/ui/render.mjs';
import { Editor } from '../src/ui/input.mjs';
import { WorkspaceState } from '../src/state.mjs';
import { TerminalApp, trustWorkspace } from '../src/ui/app.mjs';
import { validateConfig } from '../src/config.mjs';
import { clean, width } from '../src/util.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
function app() { return { config: validateConfig({}), state: new WorkspaceState(), editor: new Editor(), cwd: process.cwd(), branch: 'main', busy: false, scroll: 0, expanded: false }; }

test('frames fit multiple terminal dimensions and retain the composer', () => {
  for (const [cols, rows] of [[120, 32], [80, 24], [36, 14], [15, 7], [5, 3]]) {
    const workspace = app(); workspace.state.apply({ type: 'message', role: 'assistant', text: 'hello '.repeat(500) });
    workspace.editor.set('draft 你好');
    const frame = renderFrame(workspace, cols, rows, true);
    assert.equal(frame.lines.length, rows);
    for (const line of frame.lines) assert.ok(width(line) <= cols - 1, `overflow at ${cols}x${rows}: ${clean(line)}`);
    if (cols >= 36 && rows >= 14) { assert.ok(frame.lines.some(line => clean(line).includes('draft'))); assert.ok(frame.cursor.row <= rows); assert.ok(frame.cursor.column < cols); }
  }
});
test('approval defaults to Deny and its controls remain visible in a small viewport', () => {
  const workspace = app(); workspace.permission = { title: 'Run command?', detail: 'No OS sandbox. This can access your files.', input: 'echo '.repeat(1000), risk: 'high', allow: false };
  const frame = renderFrame(workspace, 60, 14, false);
  assert.ok(frame.lines.some(line => line.includes('[ Deny ]')));
  assert.ok(frame.lines.some(line => line.includes('Risk: high')));
});
test('terminal output cannot inject escape commands into a frame', () => {
  const workspace = app(); workspace.state.apply({ type: 'message', role: 'assistant', text: 'hi\x1b]52;c;secret\x07there\x1b[2J' });
  const frame = renderFrame(workspace, 80, 24, false);
  assert.ok(frame.lines.some(line => line.includes('hithere')));
  assert.ok(frame.lines.every(line => !line.includes('\x1b')));
});
test('screen uses differential updates and restores terminal modes', () => {
  const output = new PassThrough(); let bytes = ''; output.on('data', chunk => { bytes += chunk; });
  const screen = new Screen(output); screen.enter(); screen.paint({ lines: ['one', 'two'], cursor: null });
  bytes = ''; screen.paint({ lines: ['one', 'three'], cursor: null });
  assert.ok(!bytes.includes('one')); assert.ok(bytes.includes('three')); screen.leave();
  assert.ok(bytes.includes('\x1b[?1049l')); assert.ok(bytes.includes('\x1b[?2004l')); assert.ok(bytes.includes('\x1b[?25h'));
});
test('permission UI rejects Enter by default and pasted text cannot approve', async () => {
  const workspace = new TerminalApp({ cwd: process.cwd(), config: validateConfig({}), output: new PassThrough() });
  workspace.schedule = () => {};
  const pending = workspace.ask({ title: 'Approve?', input: 'danger' });
  workspace.handleKey({ text: 'yes\n' }); assert.equal(workspace.permission.allow, false);
  workspace.handleKey({ key: 'enter' }); assert.equal(await pending, false);
  const approved = workspace.ask({ title: 'Approve?', input: 'explicit' });
  workspace.handleKey({ key: 'right' }); workspace.handleKey({ key: 'enter' }); assert.equal(await approved, true);
});
test('permission abort resolves without leaving a hanging prompt', async () => {
  const workspace = new TerminalApp({ cwd: process.cwd(), config: validateConfig({}), output: new PassThrough() }); workspace.schedule = () => {};
  const controller = new AbortController(); const pending = workspace.ask({ title: 'Approve?' }, controller.signal);
  controller.abort(); assert.equal(await pending, false); assert.equal(workspace.permission, null);
});
test('denied workspace trust remains denied on a later connection attempt', async t => {
  const root = await mkdtemp(join(tmpdir(), 'zc-trust-')); t.after(() => rm(root, { recursive: true, force: true }));
  const old = process.env.ZC_HOME; process.env.ZC_HOME = root; t.after(() => { if (old === undefined) delete process.env.ZC_HOME; else process.env.ZC_HOME = old; });
  let prompts = 0;
  const options = { cwd: process.cwd(), config: validateConfig({}), ask: async () => { prompts++; return false; } };
  await assert.rejects(trustWorkspace(options), /not granted/); await assert.rejects(trustWorkspace(options), /not granted/);
  assert.equal(prompts, 2);
});
test('presentation storage remains bounded across a long session', () => {
  const state = new WorkspaceState();
  for (let i = 0; i < 1000; i++) state.apply({ type: 'message', id: String(i), text: 'x'.repeat(1000) });
  assert.ok(state.entries.length <= 400); assert.equal(state.entries.at(-1).id, '999');
});
