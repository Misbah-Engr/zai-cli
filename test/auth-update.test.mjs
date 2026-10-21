import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { streamVersionIdentity, STREAM_CLIENT_VERSION, STREAM_CLIENT_VERSIONS, streamErrorMessage } from '../src/backends/stream-contract.mjs';
import { runNativeStream, probeStreamRuntime, NativeStreamBackend } from '../src/backends/native-stream.mjs';
import { validateConfig } from '../src/config.mjs';
import { spawnProcess } from '../src/process.mjs';
const model = 'account:zai-individual-coding-plan/GLM-5.3';
const fixture = fileURLToPath(new URL('./fixtures/native-stream.mjs', import.meta.url));
const runtime = { command: process.execPath, args: [fixture] };
const versionText = client => `zcode-app-cli ${client}\nzcode-runtime 0.16.9\n`;
for (const version of ['3.15.3-36', '3.15.3-37']) {
  test(`accept only explicitly supported identity ${version}`, () => {
    assert.deepEqual(streamVersionIdentity(versionText(version)), { client: version, runtime: '0.16.9' });
  });
}
test('preferred client and compatibility set are explicit and immutable', () => {
  assert.equal(STREAM_CLIENT_VERSION, '3.15.3-37');
  assert.deepEqual(STREAM_CLIENT_VERSIONS, ['3.15.3-36', '3.15.3-37']);
  assert.ok(Object.isFrozen(STREAM_CLIENT_VERSIONS));
});
test('version parsing accepts CRLF without normalizing identifiers', () => {
  assert.equal(streamVersionIdentity(versionText('3.15.3-37').replaceAll('\n', '\r\n')).client, '3.15.3-37');
});
test('unknown clients and runtime revisions are rejected', () => {
  for (const v of ['3.15.3-38', '3.15.3-3', '3.15.3-37-extra', '3.15.3-37 ']) assert.equal(streamVersionIdentity(versionText(v)), undefined);
  assert.equal(streamVersionIdentity(versionText('3.15.3-37').replace('0.16.9','0.17.0')), undefined);
});
test('mixed or duplicated version identities cannot bypass compatibility checks', () => {
  for (const line of ['zcode-app-cli 3.15.3-36', 'zcode-app-cli 3.15.3-37', 'zcode-runtime 0.16.9', 'zcode-runtime 999']) {
    assert.equal(streamVersionIdentity(versionText('3.15.3-37') + line), undefined);
  }
});
test('missing or oversized version output is rejected', () => {
  for (const text of [null, {}, '', 'zcode-runtime 0.16.9', 'zcode-app-cli 3.15.3-37', 'x'.repeat(2001)]) {
    assert.equal(streamVersionIdentity(text), undefined);
  }
});
test('new subprocess identity is returned rather than hardcoded to the old client', async () => {
  assert.deepEqual(await probeStreamRuntime(runtime, process.cwd()), { client: '3.15.3-37', runtime: '0.16.9' });
});
test('launch retains environment, explicit model, exclusions, and literal prompt', async () => {
  const cwd = process.cwd(), text = 'read smoke.txt'; let calls = 0;
  const result = await runNativeStream({ runtime, cwd, model, text, emit: () => {}, totalTimeout: 4000,
    spawnImpl(command, args, options) {
      calls++;
      assert.equal(command, process.execPath);
      assert.deepEqual(args, [fixture, '--model', model, '--mode', 'guarded', '--disallowedTools',
        'Bash,Write,Edit,NotebookEdit,Task,Agent,CreateWorkflow,AmendWorkflow', '--output-format', 'stream-json', '--prompt', text]);
      assert.equal(options.env, process.env); assert.equal(options.cwd, cwd);
      assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
      return spawnProcess(command, args, options);
    }
  });
  assert.equal(calls, 1); assert.equal(result.response, 'ZC_NATIVE_FILE_READ_OK');
});
test('an authentication failure causes one launch with no login or retry', async () => {
  let calls = 0;
  await assert.rejects(runNativeStream({ runtime, cwd: process.cwd(), model, text: 'auth-error', emit: () => {},
    totalTimeout: 4000, shutdownMs: 100,
    spawnImpl(command, args, options) { calls++; assert.ok(!args.includes('login')); return spawnProcess(command, args, options); }
  }), /does not prove your login expired/);
  assert.equal(calls, 1);
});
test('auth diagnostics do not echo raw headers or prescribe unconditional authorization', () => {
  const message = streamErrorMessage('project_token_login_failed Authorization: Bearer PRIVATE_SENTINEL');
  assert.ok(!message.includes('PRIVATE_SENTINEL'));
  assert.ok(!message.includes('login --oauth'));
  assert.match(message, /No login or retry was attempted/);
});
test('legacy compatibility warning is displayed without changing credentials or client config', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'zc-auth-update-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const config = validateConfig({ backend: 'native-stream', mode: 'guarded', streamModel: model, runtime });
  const original = JSON.stringify(config), events = [];
  const b = new NativeStreamBackend({ cwd, config, storeHome: join(cwd, 'state'), emit: e => events.push(e),
    probe: async () => ({ client: '3.15.3-36', runtime: '0.16.9' }) });
  t.after(() => b.dispose());
  await b.start();
  assert.ok(events.some(e => e.text?.includes('predates the shared-OAuth repair')));
  assert.equal(JSON.stringify(config), original);
});
