import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveRuntime, runtimeEnvironment, supportsRuntimeNode, RUNTIME_VERSION } from '../src/runtime.mjs';
import { validateConfig } from '../src/config.mjs';
async function manifest(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'zc managed fixture ')); t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'bin')); await writeFile(join(dir, 'bin', 'zcode.js'), '// Synthetic public-bin fixture. No model calls.\n');
  const file = join(dir, 'package.json'); await writeFile(file, JSON.stringify({ name: 'zcode-app-cli', version: RUNTIME_VERSION, bin: { zcode: 'bin/zcode.js' }, ...overrides })); return { file, dir };
}
test('new configurations choose integrated native runtime and terminal-aware theme', () => {
  const c = validateConfig({}); assert.equal(c.runtime.command, 'managed'); assert.equal(c.backend, 'native'); assert.equal(c.theme, 'auto');
});
test('managed resolver uses the public bin and the same Node engine with paths containing spaces', async t => {
  const { file, dir } = await manifest(t); const r = resolveRuntime({ command: 'managed', args: [] }, { resolvePackage: () => file });
  assert.equal(r.managed, true); assert.equal(r.command, process.execPath); assert.equal(r.args[0], join(dir, 'bin', 'zcode.js')); assert.doesNotMatch(r.args[0], /vendor/);
});
test('missing managed package has no silent external or direct API fallback', () => {
  assert.throws(() => resolveRuntime({ command: 'managed', args: [] }, { resolvePackage: () => { throw new Error('missing'); } }), /dependency is missing/);
});
test('mismatched upstream dependency is rejected', async t => {
  const { file } = await manifest(t, { version: '0.0.0' }); assert.throws(() => resolveRuntime({ command: 'managed', args: [] }, { resolvePackage: () => file }), /mismatch/);
});
test('runtime entry cannot escape its package', async t => {
  const { file } = await manifest(t, { bin: { zcode: '../../outside.js' } }); assert.throws(() => resolveRuntime({ command: 'managed', args: [] }, { resolvePackage: () => file }), /outside/);
});
test('explicit external runtime is preserved for advanced integrations', () => {
  const r = resolveRuntime({ command: '/custom/node', args: ['/custom/cli.mjs'] }); assert.deepEqual(r, { command: '/custom/node', args: ['/custom/cli.mjs'], managed: false });
});
test('managed child uses the selected engine and standalone auth without copying tokens', () => {
  const env = runtimeEnvironment({ managed: true, command: '/isolated/node' }, { HOME: '/home/fixture', ZCODE_NODE: '/old/node' });
  assert.equal(env.ZCODE_NODE, '/isolated/node'); assert.equal(env.ZCODE_APP_SERVER_AUTH_MODE, 'standalone'); assert.equal(env.HOME, '/home/fixture');
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'ZCODE_APP_SERVER_AUTH_MODE', 'ZCODE_NODE']);
});
test('explicit advanced host authentication choice is not silently overridden', () => {
  assert.equal(runtimeEnvironment({}, { ZCODE_APP_SERVER_AUTH_MODE: 'host' }).ZCODE_APP_SERVER_AUTH_MODE, 'host');
});
test('runtime engine requirement is checked by version components, not lexical order', () => {
  for (const v of ['18.19.1', '22.16.0', '24.9.0', '24.13.9']) assert.equal(supportsRuntimeNode(v), false);
  for (const v of ['24.14.0', '24.22.0', '26.0.0']) assert.equal(supportsRuntimeNode(v), true);
});
