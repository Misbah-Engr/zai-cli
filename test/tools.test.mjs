import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTools, TOOL_DEFINITIONS } from '../src/tools.mjs';

async function fixture(t, options = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'zai-tools-test-'));
  const cwd = path.join(temporary, 'workspace');
  await fs.mkdir(cwd);
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const approvals = [];
  const approve = options.approve ?? (async (request) => { approvals.push(request); return true; });
  return { temporary, cwd, approvals, ...createTools({ cwd, approve, signal: options.signal }) };
}

const shellQuote = (value) => process.platform === 'win32' ? `"${value.replaceAll('"', '\\"')}"` : `'${value.replaceAll("'", "'\\''")}'`;
const nodeCommand = (script) => `${shellQuote(process.execPath)} -e ${shellQuote(script)}`;

test('tool definitions expose six valid function schemas', () => {
  assert.deepEqual(TOOL_DEFINITIONS.map((tool) => tool.function.name), ['list_files', 'read_file', 'search', 'write_file', 'edit_file', 'run_command']);
  for (const tool of TOOL_DEFINITIONS) {
    assert.equal(tool.type, 'function');
    assert.equal(tool.function.parameters.additionalProperties, false);
  }
});

test('all tools deny by default and denial does not change files or run commands', async (t) => {
  const { cwd } = await fixture(t);
  await fs.writeFile(path.join(cwd, 'file.txt'), 'original');
  const { execute } = createTools({ cwd });
  for (const [name, args] of [
    ['list_files', {}], ['read_file', { path: 'file.txt' }], ['search', { query: 'original' }],
    ['write_file', { path: 'new.txt', content: 'new' }],
    ['write_file', { path: 'file.txt', content: 'replacement', overwrite: true }],
    ['edit_file', { path: 'file.txt', old_text: 'original', new_text: 'changed' }],
    ['run_command', { command: nodeCommand("require('fs').writeFileSync('ran', 'yes')") }],
  ]) await assert.rejects(execute(name, args), /Permission denied/);
  assert.equal(await fs.readFile(path.join(cwd, 'file.txt'), 'utf8'), 'original');
  await assert.rejects(fs.stat(path.join(cwd, 'new.txt')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(cwd, 'ran')), { code: 'ENOENT' });
});

test('approval accepts only literal true', async (t) => {
  const { cwd } = await fixture(t);
  for (const answer of ['yes', 1, {}, undefined, null]) {
    await assert.rejects(createTools({ cwd, approve: () => answer }).execute('list_files'), /Permission denied/);
  }
});

test('rejects unknown tools, arguments, malformed limits, and traversal', async (t) => {
  const { execute, temporary } = await fixture(t);
  await assert.rejects(execute('invented', {}), /Unknown tool/);
  await assert.rejects(execute('list_files', { surprise: true }), /Unknown argument/);
  await assert.rejects(execute('read_file', {}), /Missing required/);
  await assert.rejects(execute('list_files', { max_entries: 1001 }), /max_entries/);
  await assert.rejects(execute('list_files', { recursive: 'yes' }), /recursive/);
  await assert.rejects(execute('search', { query: 'a\nb' }), /one line/);
  for (const invalid of ['../outside', 'a/../../outside', temporary, 'C:/outside', 'a\\b', 'a\0b', 'file.txt:payload']) {
    await assert.rejects(execute('read_file', { path: invalid }), /Path|paths|traversal|backslashes/);
    await assert.rejects(execute('write_file', { path: invalid, content: 'no' }), /Path|paths|traversal|backslashes/);
  }
});

test('protected names are inaccessible and omitted from listing and search', async (t) => {
  const { execute, cwd } = await fixture(t);
  const names = ['.env', '.envrc', '.env.local', '.ENV.PRODUCTION', 'credentials.json', 'api-key.txt', 'secret.yaml', 'server.pem', '.npmrc', '.git-credentials'];
  for (const name of names) await fs.writeFile(path.join(cwd, name), 'needle');
  for (const directory of ['.git', 'node_modules', '.ssh', '.aws', '.zai-workbench']) {
    await fs.mkdir(path.join(cwd, directory));
    await fs.writeFile(path.join(cwd, directory, 'file.txt'), 'needle');
    names.push(`${directory}/file.txt`);
  }
  await fs.writeFile(path.join(cwd, 'okay.txt'), 'needle');
  for (const name of names) {
    await assert.rejects(execute('read_file', { path: name }), /Protected/);
    await assert.rejects(execute('write_file', { path: name, content: 'overwrite', overwrite: true }), /Protected/);
    await assert.rejects(execute('search', { path: name, query: 'needle' }), /Protected/);
  }
  assert.deepEqual((await execute('list_files', { recursive: true })).entries, [{ path: 'okay.txt', type: 'file' }]);
  assert.equal((await execute('search', { query: 'needle' })).matches.length, 1);
});

test('symlink file and directory escapes are rejected for reads, writes, and command cwd', async (t) => {
  const { execute, cwd, temporary } = await fixture(t);
  const outside = path.join(temporary, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'data.txt'), 'outside');
  try {
    await fs.symlink(outside, path.join(cwd, 'jump'), process.platform === 'win32' ? 'junction' : 'dir');
    await fs.symlink(path.join(outside, 'data.txt'), path.join(cwd, 'linked.txt'), 'file');
  } catch (error) {
    if (error.code === 'EPERM') { t.skip('This machine does not allow creating test symlinks.'); return; }
    throw error;
  }
  await assert.rejects(execute('read_file', { path: 'linked.txt' }), /Symlinks/);
  await assert.rejects(execute('read_file', { path: 'jump/data.txt' }), /Symlinks/);
  await assert.rejects(execute('write_file', { path: 'jump/new.txt', content: 'no' }), /Symlinks/);
  await assert.rejects(execute('run_command', { cwd: 'jump', command: 'echo no' }), /Symlinks/);
  assert.deepEqual((await execute('list_files', { recursive: true })).entries, []);
  assert.equal((await execute('search', { query: 'outside' })).matches.length, 0);
  assert.equal(await fs.readFile(path.join(outside, 'data.txt'), 'utf8'), 'outside');
});

test('hardlinks cannot bypass workspace read and edit restrictions', async (t) => {
  const { execute, cwd, temporary } = await fixture(t);
  const outside = path.join(temporary, 'external.txt');
  await fs.writeFile(outside, 'protected outside');
  await fs.link(outside, path.join(cwd, 'link.txt'));
  await assert.rejects(execute('read_file', { path: 'link.txt' }), /hard links/);
  await assert.rejects(execute('edit_file', { path: 'link.txt', old_text: 'outside', new_text: 'changed' }), /hard links/);
  assert.equal(await fs.readFile(outside, 'utf8'), 'protected outside');
});

test('listing is bounded and content reads report line and byte truncation', async (t) => {
  const { execute, cwd, approvals } = await fixture(t);
  for (const name of ['a.txt', 'b.txt', 'c.txt']) await fs.writeFile(path.join(cwd, name), 'one\ntwo\nthree\n');
  const listing = await execute('list_files', { max_entries: 2 });
  assert.equal(listing.entries.length, 2);
  assert.equal(listing.truncated, true);
  const file = await execute('read_file', { path: 'a.txt', start_line: 2, max_lines: 1 });
  assert.equal(file.content, 'two');
  assert.equal(file.truncated, true);
  const byteLimited = await execute('read_file', { path: 'a.txt', max_bytes: 2 });
  assert.equal(byteLimited.content, 'on');
  assert.equal(byteLimited.truncated, true);
  assert.ok(approvals.every((request) => request.kind === 'read' && request.details.includes('model')));
});

test('search is literal, bounded, case configurable, and skips binary files', async (t) => {
  const { execute, cwd } = await fixture(t);
  await fs.mkdir(path.join(cwd, 'src'));
  await fs.writeFile(path.join(cwd, 'src', 'a.txt'), 'Needle\nneedle\nneedle\na.*b\n');
  await fs.writeFile(path.join(cwd, 'binary.bin'), Buffer.from('needle\0needle'));
  const limited = await execute('search', { query: 'needle', max_results: 2 });
  assert.equal(limited.matches.length, 2);
  assert.equal(limited.truncated, true);
  assert.equal((await execute('search', { query: 'Needle', case_sensitive: true })).matches.length, 1);
  const literal = await execute('search', { query: 'a.*b' });
  assert.equal(literal.matches.length, 1);
  assert.equal(literal.matches[0].line, 4);
  assert.equal(literal.skipped_files, 1);
});

test('write create and overwrite approvals contain complete previews', async (t) => {
  const { execute, cwd, approvals } = await fixture(t);
  const created = await execute('write_file', { path: 'new/nested.txt', content: 'first' });
  assert.equal(created.created, true);
  assert.equal(await fs.readFile(path.join(cwd, 'new/nested.txt'), 'utf8'), 'first');
  assert.equal(approvals[0].kind, 'write');
  assert.match(approvals[0].details, /AFTER\nfirst/);
  await assert.rejects(execute('write_file', { path: 'new/nested.txt', content: 'second' }), /already exists/);
  const replaced = await execute('write_file', { path: 'new/nested.txt', content: 'second', overwrite: true });
  assert.equal(replaced.created, false);
  assert.deepEqual(approvals.slice(1).map((request) => request.kind), ['read', 'write']);
  assert.match(approvals[2].details, /BEFORE\nfirst\n\nAFTER\nsecond/);
  assert.equal(await fs.readFile(path.join(cwd, 'new/nested.txt'), 'utf8'), 'second');
});

test('edit requires a unique exact match and write approval', async (t) => {
  const { execute, cwd, approvals } = await fixture(t);
  await fs.writeFile(path.join(cwd, 'file.txt'), 'cat cat\ndog\n');
  await assert.rejects(execute('edit_file', { path: 'file.txt', old_text: 'cat', new_text: 'fox' }), /more than once/);
  await assert.rejects(execute('edit_file', { path: 'file.txt', old_text: 'missing', new_text: 'fox' }), /not found/);
  await assert.rejects(execute('edit_file', { path: 'file.txt', old_text: '', new_text: 'fox' }), /nonempty/);
  await execute('edit_file', { path: 'file.txt', old_text: 'dog', new_text: 'fox' });
  assert.equal(await fs.readFile(path.join(cwd, 'file.txt'), 'utf8'), 'cat cat\nfox\n');
  assert.equal(approvals.at(-1).kind, 'write');
  assert.match(approvals.at(-1).details, /REMOVE\ndog\n\nINSERT\nfox/);
  const denied = createTools({ cwd, approve: ({ kind }) => kind === 'read' });
  await assert.rejects(denied.execute('edit_file', { path: 'file.txt', old_text: 'fox', new_text: 'dog' }), /Permission denied/);
  assert.equal(await fs.readFile(path.join(cwd, 'file.txt'), 'utf8'), 'cat cat\nfox\n');
});

test('concurrent file changes after approval are not overwritten', async (t) => {
  const { cwd } = await fixture(t);
  await fs.writeFile(path.join(cwd, 'file.txt'), 'original');
  const { execute } = createTools({ cwd, approve: async ({ kind }) => {
    if (kind === 'write') await fs.writeFile(path.join(cwd, 'file.txt'), 'external edit');
    return true;
  } });
  await assert.rejects(execute('edit_file', { path: 'file.txt', old_text: 'original', new_text: 'replacement' }), /changed after the preview/);
  assert.equal(await fs.readFile(path.join(cwd, 'file.txt'), 'utf8'), 'external edit');
  assert.deepEqual((await fs.readdir(cwd)).sort(), ['file.txt']);
});

test('concurrent file creation is not overwritten', async (t) => {
  const { cwd } = await fixture(t);
  const { execute } = createTools({ cwd, approve: async () => {
    await fs.writeFile(path.join(cwd, 'new.txt'), 'someone else');
    return true;
  } });
  await assert.rejects(execute('write_file', { path: 'new.txt', content: 'model' }), { code: 'EEXIST' });
  assert.equal(await fs.readFile(path.join(cwd, 'new.txt'), 'utf8'), 'someone else');
});

test('exec previews the exact command and warns about access without a sandbox', async (t) => {
  const { execute, approvals } = await fixture(t);
  const command = nodeCommand("process.stdout.write('ok');process.stderr.write('error');process.exitCode=7");
  const result = await execute('run_command', { command });
  assert.equal(result.stdout, 'ok');
  assert.equal(result.stderr, 'error');
  assert.equal(result.exit_code, 7);
  assert.equal(result.cancelled, false);
  assert.equal(approvals[0].kind, 'exec');
  assert.match(approvals[0].details, /no OS sandbox/i);
  assert.ok(approvals[0].details.endsWith(command));
});

test('exec does not inherit API keys, arbitrary env, HOME, or NODE_OPTIONS', async (t) => {
  const { execute } = await fixture(t);
  const names = ['ZAI_API_KEY', 'OPENAI_API_KEY', 'MY_PRIVATE_VALUE', 'NODE_OPTIONS', 'HOME'];
  const saved = new Map(names.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  for (const name of names) process.env[name] = name === 'NODE_OPTIONS' ? '--no-warnings' : 'do-not-inherit';
  const result = await execute('run_command', { command: nodeCommand(`console.log(JSON.stringify(${JSON.stringify(names)}.filter(key => process.env[key])))`) });
  assert.equal(result.exit_code, 0);
  assert.deepEqual(JSON.parse(result.stdout), []);
});

test('exec output cap terminates a noisy process and bounds combined output', async (t) => {
  const { execute } = await fixture(t);
  const result = await execute('run_command', { command: nodeCommand("setInterval(()=>{process.stdout.write('x'.repeat(8192));process.stderr.write('y'.repeat(8192))},1)"), max_output_bytes: 1000 });
  assert.equal(result.output_truncated, true);
  assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 1000);
});

test('exec timeout terminates an idle process promptly', async (t) => {
  const { execute } = await fixture(t);
  const started = Date.now();
  const result = await execute('run_command', { command: nodeCommand('setInterval(()=>{},1000)'), timeout_ms: 80 });
  assert.equal(result.timed_out, true);
  assert.ok(Date.now() - started < 3000);
});

test('cancellation during execution stops the process and returns cancellation', async (t) => {
  const controller = new AbortController();
  const { execute } = await fixture(t, { signal: controller.signal });
  const pending = execute('run_command', { command: nodeCommand('setInterval(()=>{},1000)') });
  const timer = setTimeout(() => controller.abort(), 80);
  t.after(() => clearTimeout(timer));
  const result = await pending;
  assert.equal(result.cancelled, true);
  assert.equal(result.timed_out, false);
});

test('already aborted and approval-time cancellation never start a command', async (t) => {
  const { cwd } = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(createTools({ cwd, approve: () => true, signal: controller.signal }).execute('run_command', { command: 'echo no' }), { name: 'AbortError' });
  const during = new AbortController();
  const { execute } = createTools({ cwd, signal: during.signal, approve: () => { during.abort(); return true; } });
  await assert.rejects(execute('run_command', { command: nodeCommand("require('fs').writeFileSync('ran','yes')") }), { name: 'AbortError' });
  await assert.rejects(fs.stat(path.join(cwd, 'ran')), { code: 'ENOENT' });
});

test('POSIX timeout kills children in the spawned process group', { skip: process.platform === 'win32' }, async (t) => {
  const { execute, cwd } = await fixture(t);
  const script = "const {spawn}=require('child_process');const c=spawn(process.execPath,['-e',\"setInterval(()=>{},1000)\"],{stdio:'inherit'});require('fs').writeFileSync('child.pid',String(c.pid));setInterval(()=>{},1000)";
  const result = await execute('run_command', { command: nodeCommand(script), timeout_ms: 250 });
  assert.equal(result.timed_out, true);
  const pid = Number(await fs.readFile(path.join(cwd, 'child.pid'), 'utf8'));
  // Linux can leave an already-killed orphan briefly visible as a zombie.
  try {
    const status = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
    assert.match(status, /\) Z /);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
});


test('portable paths reject Windows device names and trailing dots/spaces', async (t) => {
  const { execute } = await fixture(t);
  for (const name of ['CON', 'aux.txt', 'dir/NUL', 'COM1.js', 'LPT9', 'file.', 'file ']) {
    await assert.rejects(execute('read_file', { path: name }), /Reserved/);
  }
});

test('interrupted POSIX commands kill descendants that ignore SIGTERM after the shell closes', { skip: process.platform !== 'linux' }, async (t) => {
  const { execute, cwd } = await fixture(t);
  const childScript = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
  const script = `const c=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:'ignore'});require('fs').writeFileSync('ignoring-child.pid',String(c.pid));setInterval(()=>{},1000)`;
  const result = await execute('run_command', { command: nodeCommand(script), timeout_ms: 250 });
  assert.equal(result.timed_out, true);
  const pid = Number(await fs.readFile(path.join(cwd, 'ignoring-child.pid'), 'utf8'));
  // kill(2) queues SIGKILL. A process can remain runnable briefly until the
  // scheduler delivers it; require actual death rather than mere signal issuance.
  const deadline = Date.now() + 2000;
  let status;
  while (Date.now() < deadline) {
    try { status = await fs.readFile(`/proc/${pid}/stat`, 'utf8'); }
    catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return; throw error; }
    if (/\) Z /.test(status)) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`Descendant ${pid} survived SIGKILL cleanup: ${status}`);
});


test('invalid UTF-8 cannot be silently corrupted by an edit', async (t) => {
  const { execute, cwd } = await fixture(t);
  const bytes = Buffer.from([0x61, 0xff, 0x62]);
  await fs.writeFile(path.join(cwd, 'legacy.txt'), bytes);
  await assert.rejects(execute('edit_file', { path: 'legacy.txt', old_text: 'a', new_text: 'c' }), /UTF-8/);
  assert.deepEqual(await fs.readFile(path.join(cwd, 'legacy.txt')), bytes);
});

test('UTF-8 output caps preserve code points and edits preserve a UTF-8 BOM', async (t) => {
  const { execute, cwd } = await fixture(t);
  await fs.writeFile(path.join(cwd, 'unicode.txt'), '\ufeff🙂hello');
  assert.equal((await execute('read_file', { path: 'unicode.txt', max_bytes: 6 })).content, '\ufeff');
  await execute('edit_file', { path: 'unicode.txt', old_text: 'hello', new_text: 'world' });
  assert.equal(await fs.readFile(path.join(cwd, 'unicode.txt'), 'utf8'), '\ufeff🙂world');
});
