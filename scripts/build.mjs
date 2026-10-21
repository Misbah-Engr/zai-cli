import { readdir, readFile, lstat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let checked = 0;
async function scan(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', 'coverage'].includes(entry.name)) continue;
    const full = join(path, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symlink is not permitted in the package source: ${full}`);
    if (entry.isDirectory()) await scan(full);
    else if (/\.(?:mjs|js|json|md|yml|yaml)$/.test(entry.name) || ['LICENSE', 'NOTICE'].includes(entry.name)) {
      const content = await readFile(full, 'utf8');
      if (content.includes(String.fromCharCode(0x2014))) throw new Error(`Prohibited punctuation in ${full}`);
      if (/\.(?:mjs|js)$/.test(entry.name)) {
        const check = spawnSync(process.execPath, ['--check', full], { encoding: 'utf8' });
        if (check.status !== 0) throw new Error(check.stderr);
        checked++;
      }
    }
  }
}
await scan(root);
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
for (const entry of Object.values(pkg.bin)) await lstat(join(root, entry));
console.error(`Build verified: ${checked} JavaScript modules; frontend syntax and package entries checked. Runtime integration requires the pinned dependency.`);
