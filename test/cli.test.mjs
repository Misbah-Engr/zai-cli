import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess } from '../src/process.mjs';
import { supportsRuntimeNode } from '../src/runtime.mjs';
import { VERSION } from '../src/util.mjs';
const bin = fileURLToPath(new URL('../bin/zc.mjs', import.meta.url));
async function cli(t, args, extraEnv = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'zc-cli-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await runProcess(process.execPath, [bin, ...args], { cwd: dir, env: { ...process.env, ZC_HOME: join(dir, 'state'), ZAI_API_KEY: '', ...extraEnv }, timeout: 8000 });
  return { ...result, dir };
}
test('CLI version and help run without configuration or network', async t => {
  assert.equal((await cli(t, ['--version'])).output.trim(), VERSION);
  const help = await cli(t, ['--help']); assert.equal(help.code, 0); assert.ok(help.output.includes(`ZC ${VERSION}`));
});
test('unknown flags fail instead of being ignored', async t => {
  const result = await cli(t, ['--auto-approve']); assert.equal(result.code, 1); assert.match(result.output, /Unknown option/);
});
test('doctor JSON does not disclose the supplied API key', async t => {
  const result = await cli(t, ['doctor', '--backend', 'zai', '--json'], { ZAI_API_KEY: 'dummy-key-should-stay-private' });
  assert.equal(result.code, supportsRuntimeNode() ? 0 : 1); assert.doesNotMatch(result.output, /dummy-key-should-stay-private/);
  assert.equal(JSON.parse(result.output).checks.find(c => c.name === 'api_key').ok, true);
});
test('exec without an API key fails before making a model request', async t => {
  const result = await cli(t, ['exec', 'hello', '--backend', 'zai', '--trust']);
  assert.equal(result.code, 1); assert.match(result.output, /ZAI_API_KEY is not set/);
});
test('noninteractive untrusted workspace does not start a model session', async t => {
  const result = await cli(t, ['exec', 'hello', '--backend', 'zai'], { ZAI_API_KEY: 'dummy' });
  assert.equal(result.code, 1); assert.match(result.output, /trust was not granted/);
});
test('offline demo output is labeled and printed once', async t => {
  const result = await cli(t, ['demo', '--plain']);
  assert.equal(result.code, 0); assert.match(result.output, /OFFLINE DEMO/);
  assert.equal(result.output.split('Your composer stays put.').length - 1, 1);
});
test('noninteractive backend setup saves a usable config', async t => {
  const result = await cli(t, ['setup', '--backend', 'zai']); assert.equal(result.code, 0);
  const config = JSON.parse(await readFile(join(result.dir, 'state', 'config.json'), 'utf8')); assert.equal(config.backend, 'zai');
});

test('native diagnostics do not report account-authentication support as ready', async t => {
  const result = await cli(t, ['doctor', '--backend', 'native', '--json']);
  assert.equal(result.code, 1);
  const diagnostic = JSON.parse(result.output);
  const auth = diagnostic.checks.find(check => check.name === 'authentication');
  assert.equal(auth.ok, null); assert.match(auth.detail, /Not tested/);
});
