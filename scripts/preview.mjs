#!/usr/bin/env node
// Emit a reproducible frame from the real renderer and offline demo backend.
// This is a rendering fixture, not a live provider session or a rasterizer.
import { WorkspaceState } from '../src/state.mjs';
import { DemoBackend } from '../src/backends/demo.mjs';
import { Editor } from '../src/ui/input.mjs';
import { renderFrame } from '../src/ui/render.mjs';
import { validateConfig } from '../src/config.mjs';
const state = new WorkspaceState();
const config = validateConfig({ backend: 'zai' });
const backend = new DemoBackend({ config, emit: event => state.apply(event) });
await backend.start();
await backend.send('Show me the workspace. Keep the code in focus.');
const app = { state, config, editor: new Editor(), cwd: '/workspace/zcode-cli', branch: 'main', demo: true, busy: false, scroll: 0, expanded: false };
const frame = renderFrame(app, 110, 38, true);
process.stdout.write(JSON.stringify({ columns: 110, rows: 38, fixture: 'offline-demo', ...frame }, null, 2) + '\n');
