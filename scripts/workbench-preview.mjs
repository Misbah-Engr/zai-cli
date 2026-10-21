#!/usr/bin/env node
// Real renderer, synthetic workspace. These frames are not live provider screenshots.
import { WorkspaceState } from '../src/state.mjs';
import { Editor } from '../src/ui/input.mjs';
import { renderFrame } from '../src/ui/render.mjs';
import { validateConfig } from '../src/config.mjs';
const theme = process.argv[2] || 'light', state = new WorkspaceState(), editor = new Editor();
state.apply({ type: 'session', id: 'synthetic-preview', model: 'Example account / GLM model' });
state.apply({ type: 'mode', mode: 'ask', runtimeMode: 'guarded' });
state.apply({ type: 'notice', text: 'UI PREVIEW: synthetic conversation, no live model or tool execution.' });
state.apply({ type: 'message', role: 'user', id: 'u1', text: 'Tighten the event parser and add regression tests. Keep the public interface unchanged.' });
state.apply({ type: 'tool', id: 'r1', name: 'Read', input: { path: 'src/events/parser.ts' }, status: 'done', duration: 142, output: 'Read 88 lines.' });
state.apply({ type: 'tool', id: 'r2', name: 'Read', input: { path: 'test/events/parser.test.ts' }, status: 'done', duration: 83 });
state.apply({ type: 'message', role: 'assistant', id: 'a1', text: '## Proposed change\n\nThe parser should retain an incomplete frame until the next chunk arrives. A quiet connection is not proof that a task failed.\n\n| File | Change |\n| --- | --- |\n| src/events/parser.ts | Keep partial UTF-8 and event frames |\n| test/events/parser.test.ts | Cover split bytes, EOF and invalid frames |\n\n```ts\nconst frame = decoder.push(chunk);\nif (frame.complete) dispatch(frame.value);\n```\n\n**Review the diff before applying it.** Existing sessions and public method names stay unchanged.' });
state.apply({ type: 'usage', usage: { totalTokens: 12860 } });
editor.set('Apply the focused change and run the parser tests.\nReport the commands executed and any remaining failure.');
const start = editor.text.indexOf('parser'); editor.anchor = start; editor.cursor = start + 6;
const app = { state, editor, config: validateConfig({ theme }), cwd: '/workspace/relay', branch: 'parser-recovery', focus: 'editor', busy: false, scroll: 0, expandedTools: new Set(), expanded: false };
const frame = renderFrame(app, 120, 36, true);
console.log(JSON.stringify({ fixture: true, theme, columns: 120, rows: 36, ...frame }, null, 2));
