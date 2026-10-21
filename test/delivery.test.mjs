import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, lstat, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../src/util.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('package version, binary version, public entry, and pinned runtime dependency agree', async () => {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.version, VERSION);
  assert.deepEqual(pkg.dependencies, { 'zcode-app-cli': '3.15.3-37' });
  assert.equal(Object.keys(pkg.devDependencies || {}).length, 0);
  for (const file of Object.values(pkg.bin)) assert.ok((await lstat(join(root, file))).isFile());
});
test('documentation has no broken local links or missing images', async () => {
  const docs = ['README.md', 'SECURITY.md', ...((await readdir(join(root, 'docs'))).filter(name => name.endsWith('.md')).map(name => 'docs/' + name))];
  for (const file of docs) {
    const text = await readFile(join(root, file), 'utf8');
    for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
      const target = match[1].split('#')[0];
      if (!target || /^[a-z]+:/i.test(target)) continue;
      const path = resolve(dirname(join(root, file)), decodeURIComponent(target));
      assert.ok((await lstat(path)).isFile(), `${file}: ${target}`);
    }
  }
});
test('CI defines all three OS targets and both Node target lines', async () => {
  const ci = await readFile(join(root, '.github/workflows/ci.yml'), 'utf8');
  for (const expected of ['ubuntu-latest', 'macos-latest', 'windows-latest', '24.14.0', '24.x', 'npm run check', 'npm pack', 'zc demo --plain']) assert.ok(ci.includes(expected));
  assert.ok(ci.includes('contents: read')); assert.ok(!ci.includes('secrets.'));
});
test('CI package installation and artifact name match the current package version', async () => {
  const ci = await readFile(join(root, '.github/workflows/ci.yml'), 'utf8');
  const expected = `striking-lions-zc-${VERSION}.tgz`;
  assert.equal(ci.split(expected).length - 1, 2);
});
