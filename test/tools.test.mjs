import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, symlink, link, mkdir, lstat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Tools, safePath, readText, projectFiles, childEnvironment, changePreview } from '../src/tools.mjs';
import { runProcess } from '../src/process.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'zc-tools-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const instance = (cwd, overrides = {}) => new Tools({ cwd, mode: 'ask', ask: async () => true, emit: () => {}, ...overrides });

test('paths cannot escape, use alternate streams, or access common secrets', async t => {
  const root = await fixture(t);
  for (const path of ['../escape', '/absolute', 'C:\\escape', 'a/../../b', '.env', '.env.production', '.git/config', '.ssh/id_ed25519', 'file:stream', 'NUL', 'dir/space ']) {
    await assert.rejects(safePath(root, path, { missing: true }), undefined, path);
  }
  assert.equal(await safePath(root, 'src/file.ts', { missing: true }), join(await realpath(root), 'src', 'file.ts'));
});
test('symbolic links are blocked even when they point inside the project', async t => {
  const root = await fixture(t); await writeFile(join(root, 'file'), 'a');
  try { await symlink(join(root, 'file'), join(root, 'alias')); } catch (e) { if (e.code === 'EPERM') return t.skip('Symlink privilege unavailable'); throw e; }
  await assert.rejects(readText(root, 'alias'), /Symbolic/);
});
test('hard-linked source files are blocked', async t => {
  const root = await fixture(t); await writeFile(join(root, 'file'), 'a'); await link(join(root, 'file'), join(root, 'alias'));
  await assert.rejects(readText(root, 'alias'), /Hard-linked/);
});
test('read_file returns numbered lines and a stable hash', async t => {
  const root = await fixture(t); await writeFile(join(root, 'a.ts'), 'one\ntwo\nthree');
  const text = await instance(root).execute('read_file', { path: 'a.ts', start_line: 2, max_lines: 1 });
  assert.match(text, /SHA256: [a-f0-9]{64}/); assert.match(text, /2: two/); assert.doesNotMatch(text, /1: one/);
});
test('exact edit approval writes only the approved replacement', async t => {
  const root = await fixture(t); await writeFile(join(root, 'a.ts'), 'const n = 1;\n');
  const old = await readText(root, 'a.ts'); let approvals = 0;
  const tools = instance(root, { ask: async request => { approvals++; assert.match(request.input, /\+const n = 2;/); return true; } });
  await tools.execute('edit_file', { path: 'a.ts', expected_sha256: old.sha256, old_text: 'n = 1', new_text: 'n = 2' });
  assert.equal(approvals, 1); assert.equal(await readFile(join(root, 'a.ts'), 'utf8'), 'const n = 2;\n');
});
test('denied edits leave bytes unchanged', async t => {
  const root = await fixture(t); await writeFile(join(root, 'a'), 'original'); const old = await readText(root, 'a');
  await assert.rejects(instance(root, { ask: async () => false }).execute('edit_file', { path: 'a', expected_sha256: old.sha256, old_text: 'original', new_text: 'modified' }), /denied/);
  assert.equal(await readFile(join(root, 'a'), 'utf8'), 'original');
});
test('an external change while approval is pending is not overwritten', async t => {
  const root = await fixture(t); await writeFile(join(root, 'a'), 'original'); const old = await readText(root, 'a');
  const tools = instance(root, { ask: async () => { await writeFile(join(root, 'a'), 'concurrent edit'); return true; } });
  await assert.rejects(tools.execute('edit_file', { path: 'a', expected_sha256: old.sha256, old_text: 'original', new_text: 'modified' }), /changed while approval/);
  assert.equal(await readFile(join(root, 'a'), 'utf8'), 'concurrent edit');
});
test('stale or ambiguous edits are rejected before approval', async t => {
  const root = await fixture(t); await writeFile(join(root, 'a'), 'a a'); const old = await readText(root, 'a');
  const tools = instance(root, { ask: async () => assert.fail('Approval should not be requested') });
  await assert.rejects(tools.execute('edit_file', { path: 'a', expected_sha256: '0'.repeat(64), old_text: 'a', new_text: 'b' }), /changed/);
  await assert.rejects(tools.execute('edit_file', { path: 'a', expected_sha256: old.sha256, old_text: 'a', new_text: 'b' }), /exactly one/);
});
test('create_file refuses existing files even if they appear during approval', async t => {
  const root = await fixture(t);
  const tools = instance(root, { ask: async () => { await writeFile(join(root, 'new.ts'), 'someone else'); return true; } });
  await assert.rejects(tools.execute('create_file', { path: 'new.ts', content: 'ours' }), /EEXIST/);
  assert.equal(await readFile(join(root, 'new.ts'), 'utf8'), 'someone else');
});
test('read-only mode blocks shell and every mutation before asking', async t => {
  const root = await fixture(t);
  const tools = instance(root, { mode: 'read-only', ask: async () => assert.fail('No approval in read-only mode') });
  assert.equal(tools.definitions().length, 3);
  await assert.rejects(tools.execute('create_file', { path: 'x', content: 'x' }), /Read-only/);
  await assert.rejects(tools.execute('shell', { command: 'echo should-not-run', timeout_ms: 1000 }), /Read-only/);
});
test('tool schemas reject unknown fields and invalid integers', async t => {
  const root = await fixture(t);
  await assert.rejects(instance(root).execute('shell', { command: 'echo x', timeout_ms: -1 }), /timeout_ms/);
  await assert.rejects(instance(root).execute('list_files', { path: '.', surprise: true }), /Unexpected/);
});
test('Git-aware listing omits ignored and sensitive paths', async t => {
  const root = await fixture(t);
  const init = await runProcess('git', ['init', '-q'], { cwd: root }); if (init.code !== 0) return t.skip('Git unavailable');
  await writeFile(join(root, '.gitignore'), 'ignored.txt\n');
  await writeFile(join(root, 'ignored.txt'), 'not context'); await writeFile(join(root, '.env'), 'SECRET=x'); await writeFile(join(root, 'source.ts'), 'export {};');
  const files = await projectFiles(root);
  assert.ok(files.includes('source.ts')); assert.ok(!files.includes('ignored.txt')); assert.ok(!files.includes('.env'));
});
test('child shell environment does not inherit common credentials', () => {
  assert.deepEqual(childEnvironment({ PATH: '/bin', HOME: '/home/test', ZAI_API_KEY: 'secret', GH_TOKEN: 'secret', AWS_SECRET_ACCESS_KEY: 'secret' }), { PATH: '/bin', HOME: '/home/test' });
});
test('subprocess output is bounded and timeout terminates execution', async () => {
  const output = await runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(100000))'], { maxBytes: 1000 });
  assert.equal(output.output.length, 1000); assert.equal(output.truncated, true);
  const timeout = await runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 100 });
  assert.equal(timeout.timedOut, true);
});
test('subprocess abort rejects with an explicit cancellation', async () => {
  const controller = new AbortController();
  const pending = runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal });
  setTimeout(() => controller.abort(), 50); await assert.rejects(pending, { name: 'AbortError' });
});

// Model an aliased ancestor, as in /var/... versus /private/var/... on macOS.
// The alias is outside the workspace. Links beneath the workspace stay blocked.
async function aliasedFixture(t) {
  const parent = await fixture(t);
  const physicalParent = join(parent, 'physical');
  const aliasParent = join(parent, 'alias');
  await mkdir(join(physicalParent, 'project'), { recursive: true });
  try {
    await symlink(physicalParent, aliasParent, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) {
      t.skip('Directory-link privilege unavailable');
      return;
    }
    throw error;
  }
  const root = join(aliasParent, 'project');
  const canonicalRoot = await realpath(root);
  assert.notEqual(root, canonicalRoot, 'The fixture must exercise a real root alias.');
  return { root, canonicalRoot, parent };
}
async function gitFixture(t, root) {
  let init;
  try {
    init = await runProcess('git', ['init', '-q'], { cwd: root });
  } catch (error) {
    if (error.code === 'ENOENT') { t.skip('Git unavailable'); return false; }
    throw error;
  }
  assert.equal(init.code, 0, init.output);
  return true;
}
async function seedAliasedProject(root) {
  await mkdir(join(root, 'src'));
  await mkdir(join(root, 'src-neighbor'));
  await writeFile(join(root, '.gitignore'), 'ignored.txt\n');
  await writeFile(join(root, 'source.ts'), 'const marker = "ALIAS_SEARCH_MARKER";\n');
  await writeFile(join(root, 'src', 'nested.ts'), 'const nested = "ALIAS_SEARCH_MARKER";\n');
  await writeFile(join(root, 'src-neighbor', 'other.ts'), 'export {};\n');
  await writeFile(join(root, '.env'), 'SECRET=ALIAS_SEARCH_MARKER\n');
  await writeFile(join(root, 'src', 'private.key'), 'ALIAS_SEARCH_MARKER\n');
  await writeFile(join(root, 'ignored.txt'), 'ALIAS_SEARCH_MARKER\n');
}

test('safePath returns canonical paths through an aliased workspace ancestor', async t => {
  const f = await aliasedFixture(t); if (!f) return;
  await writeFile(join(f.root, 'source.ts'), 'export {};');
  assert.equal(await safePath(f.root, 'source.ts'), join(f.canonicalRoot, 'source.ts'));
  assert.equal(await safePath(f.root, 'new/deep/file.ts', { missing: true }), join(f.canonicalRoot, 'new', 'deep', 'file.ts'));
  assert.equal(await safePath(f.root, '.'), f.canonicalRoot);
});
test('Git listing uses the canonical workspace root without losing files to an alias prefix', async t => {
  const f = await aliasedFixture(t); if (!f || !await gitFixture(t, f.root)) return;
  await seedAliasedProject(f.root);
  const files = await projectFiles(f.root);
  assert.deepEqual(files, ['.gitignore', 'source.ts', 'src-neighbor/other.ts', 'src/nested.ts']);
  assert.deepEqual(files, await projectFiles(f.canonicalRoot));
});
test('Git subdirectory filtering through a root alias keeps only the requested directory', async t => {
  const f = await aliasedFixture(t); if (!f || !await gitFixture(t, f.root)) return;
  await seedAliasedProject(f.root);
  assert.deepEqual(await projectFiles(f.root, 'src'), ['src/nested.ts']);
  assert.deepEqual(await projectFiles(f.root, './src/'), await projectFiles(f.canonicalRoot, 'src'));
});
test('fallback listing through a root alias emits workspace-relative paths and excludes secrets', async t => {
  const f = await aliasedFixture(t); if (!f) return;
  // An invalid Git pointer makes fallback deterministic even inside a parent repo.
  await writeFile(join(f.root, '.git'), 'gitdir: missing-git-metadata\n');
  await seedAliasedProject(f.root);
  await mkdir(join(f.root, 'node_modules'));
  await writeFile(join(f.root, 'node_modules', 'excluded.js'), 'not context');
  const files = await projectFiles(f.root);
  assert.deepEqual([...files].sort(), ['.gitignore', 'ignored.txt', 'source.ts', 'src-neighbor/other.ts', 'src/nested.ts']);
  assert.deepEqual(files, await projectFiles(f.canonicalRoot));
  assert.deepEqual(await projectFiles(f.root, 'src'), ['src/nested.ts']);
  for (const path of files) {
    assert.ok(!path.startsWith('../') && !path.startsWith('/') && !path.includes('\\'));
    await readText(f.root, path);
  }
});
test('search through an aliased workspace finds source without reading ignored or private files', async t => {
  const f = await aliasedFixture(t); if (!f || !await gitFixture(t, f.root)) return;
  await seedAliasedProject(f.root);
  const result = await instance(f.root).execute('search', { query: 'ALIAS_SEARCH_MARKER', path: '.' });
  assert.match(result, /source\.ts:1:/);
  assert.match(result, /src\/nested\.ts:1:/);
  assert.doesNotMatch(result, /ignored\.txt|private\.key|SECRET=/);
});
test('aliased workspace roots retain traversal, private-path, link, and hard-link rejection', async t => {
  const f = await aliasedFixture(t); if (!f) return;
  for (const path of ['../outside', '/absolute', '.env', '.ssh/id_ed25519', 'file:stream']) {
    await assert.rejects(safePath(f.root, path, { missing: true }), undefined, path);
  }
  await mkdir(join(f.root, 'inside'));
  await mkdir(join(f.parent, 'outside'));
  await writeFile(join(f.root, 'inside', 'file.ts'), 'safe');
  await writeFile(join(f.parent, 'outside', 'file.ts'), 'outside');
  for (const [name, target] of [['inside-link', join(f.canonicalRoot, 'inside')], ['outside-link', join(f.parent, 'outside')]]) {
    await symlink(target, join(f.root, name), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(readText(f.root, `${name}/file.ts`), /Symbolic/);
    await assert.rejects(projectFiles(f.root, name), /Symbolic/);
    await assert.rejects(safePath(f.root, `${name}/new.ts`, { missing: true }), /Symbolic/);
  }
  await link(join(f.root, 'inside', 'file.ts'), join(f.root, 'hard-link.ts'));
  await assert.rejects(readText(f.root, 'hard-link.ts'), /Hard-linked/);
});
