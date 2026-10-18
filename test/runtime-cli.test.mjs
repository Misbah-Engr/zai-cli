import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
const cli = resolve('src/cli.mjs');
function run(args, env = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {env: {...process.env, ZAI_API_KEY: '', ...env}});
    let stdout = '', stderr = '';
    child.stdout.on('data', c => stdout += c);
    child.stderr.on('data', c => stderr += c);
    child.on('error', reject);
    child.on('close', code => resolveRun({code, stdout, stderr}));
  });
}
test('default runtime streams through a genuine subprocess without API credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zai-runtime-cli-'));
  const executable = join(dir, 'mock-runtime.js');
  await writeFile(executable, `#!/usr/bin/env node
const readline = require('node:readline');
if (process.argv[2] !== 'app-server') process.exit(19);
const out = x => process.stdout.write(JSON.stringify(x) + '\\n');
let sequence = 0;
readline.createInterface({input:process.stdin}).on('line', line => {
 const m = JSON.parse(line);
 if (m.method === 'session/create') {
  if (m.params.mode !== 'guarded' || m.params.model) process.exit(20);
  out({id:m.id,result:{protocol:{name:'ZCode Protocol',version:1},session:{sessionId:'mock-session'}}});
 } else if (m.method === 'session/subscribe') out({id:m.id,result:{}});
 else if (m.method === 'session/send') {
  process.stderr.write('sensitive-runtime-log-marker');
  out({method:'session/event',params:{sessionId:'mock-session',seq:++sequence,type:'model.streaming',payload:{kind:'reasoning_delta',delta:'private-reasoning-marker'}}});
  out({id:m.id,result:{}});
  out({method:'session/event',params:{sessionId:'mock-session',seq:++sequence,type:'model.streaming',payload:{kind:'text_delta',delta:'Runtime hello'}}});
  out({method:'session/event',params:{sessionId:'mock-session',seq:++sequence,type:'turn.completed',payload:{inputId:m.params.inputId,resultType:'success',response:'Runtime hello'}}});
 }
});
`, {mode: 0o700});
  try {
    const result = await run(['--runtime-path', executable, '--cwd', dir, '--plain', '-p', 'Hello']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, 'Runtime hello\n');
    assert.match(result.stderr, /runtime/);
    assert.match(result.stderr, /mock-session/);
    assert.doesNotMatch(result.stderr, /Set ZAI_API_KEY|sensitive-runtime-log-marker|private-reasoning-marker|\x1b/);
    assert.match(result.stderr, /Working/);
    assert.match(result.stderr, /Thinking/);
    assert.match(result.stderr, /Raw logs are hidden/);
  } finally {await rm(dir, {recursive: true, force: true});}
});
test('runtime rejects unsupported API flags instead of silently ignoring them', async () => {
  for (const args of [['--no-save'], ['--allow-read'], ['--profile','coding'], ['--reasoning','high'], ['--max-tools','3']]) {
    const result = await run([...args, '-p', 'Hello']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /only with --backend api/);
  }
});
test('runtime local doctor and version do not require credentials or invoke runtime', async () => {
  assert.equal((await run(['--version'])).stdout.trim(), '0.2.0');
  const result = await run(['doctor']);
  assert.equal(result.code, 0);
  assert.match(result.stderr, /Backend: runtime/);
  assert.match(result.stderr, /not tested/);
});
test('runtime requires trusted absolute override and explicit configured model IDs', async () => {
  assert.match((await run(['--runtime-path','./zcode','-p','hello'])).stderr, /absolute path/);
  assert.match((await run(['--model','glm-5.3','-p','hello'])).stderr, /PROVIDER\/MODEL/);
  assert.match((await run(['--backend','unknown','-p','hello'])).stderr, /runtime or api/);
});
test('runtime errors never fall back to API even with an API key set', async () => {
  const result = await run(['--runtime-path', join(tmpdir(), 'missing-zcode-runtime-file'), '-p', 'Hello'], {ZAI_API_KEY: 'must-not-be-used', ZAI_BASE_URL: 'http://127.0.0.1:1/v1'});
  assert.equal(result.code, 1);
  assert.doesNotMatch(result.stderr, /must-not-be-used|Endpoint:|fetch failed/);
});
