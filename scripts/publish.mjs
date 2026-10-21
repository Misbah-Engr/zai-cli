#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFile, realpath, lstat } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const { values } = parseArgs({ options: { public: { type: 'boolean' }, 'dry-run': { type: 'boolean' } }, strict: true });
const run = (command, args, { optional = false, capture = false } = {}) => {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', shell: false });
  if (!optional && (result.error || result.status !== 0)) throw new Error(result.error?.message || `${command} ${args.join(' ')} failed. No force push was attempted.`);
  return result;
};
try {
  run('git', ['--version'], { capture: true }); run('gh', ['--version'], { capture: true });
  run('gh', ['auth', 'status']);
  const login = run('gh', ['api', 'user', '--jq', '.login'], { capture: true }).stdout.trim();
  if (!/^[A-Za-z0-9-]{1,39}$/.test(login)) throw new Error('Could not safely resolve the authenticated GitHub login.');
  const target = `${login}/zcode-cli`;
  const visibility = values.public ? '--public' : '--private';
  console.log(`Target: ${target}\nVisibility: ${values.public ? 'public (explicitly requested)' : 'private'}\nSource: ${root}`);
  if (values['dry-run']) { console.log('Dry run finished. No local Git state or remote repository was changed.'); process.exitCode = 0; }
  else {
    const exists = run('gh', ['repo', 'view', target, '--json', 'nameWithOwner'], { capture: true, optional: true });
    if (exists.status === 0) throw new Error('The target repository already exists. This script only creates a new repository. See docs/PUBLISHING.md for the non-destructive existing-repository workflow.');
    run(process.execPath, ['scripts/build.mjs']);
    run(process.execPath, ['scripts/test.mjs']);
    const top = run('git', ['rev-parse', '--show-toplevel'], { capture: true, optional: true });
    if (top.status === 0 && await realpath(top.stdout.trim()) !== root) throw new Error('This source is inside another repository. Move it outside that repository before publishing.');
    if (top.status !== 0) run('git', ['init', '-b', 'main']);
    if (run('git', ['remote', 'get-url', 'origin'], { optional: true, capture: true }).status === 0) throw new Error('An origin remote is already configured. Review it manually instead of replacing it.');
    if (!run('git', ['config', 'user.name'], { optional: true, capture: true }).stdout?.trim()) run('git', ['config', 'user.name', login]);
    if (!run('git', ['config', 'user.email'], { optional: true, capture: true }).stdout?.trim()) run('git', ['config', 'user.email', `${login}@users.noreply.github.com`]);
    // Explicit source paths only. Environment files, transcripts, and build archives are not staged.
    const allow = ['package.json', 'README.md', 'LICENSE', 'NOTICE', 'SECURITY.md', 'CHANGELOG.md', '.gitignore', '.gitattributes', '.github', 'bin', 'src', 'scripts', 'test', 'docs', 'install'];
    for (const path of allow) { await lstat(join(root, path)); run('git', ['add', '--', path]); }
    const staged = run('git', ['diff', '--cached', '--quiet'], { optional: true, capture: true });
    if (staged.status === 1) run('git', ['commit', '-m', 'feat: integrate ZC workbench, runtime packaging, and editor recovery']);
    else if (staged.status !== 0) throw new Error('Could not inspect staged changes.');
    run('gh', ['repo', 'create', target, visibility, '--description', 'A focused terminal workspace for Z.ai and the ZCode runtime.', '--source', '.', '--remote', 'origin', '--push']);
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const tag = `v${pkg.version}`;
    if (!/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(tag)) throw new Error('Unexpected release version.');
    const existingTag = run('git', ['rev-parse', '--verify', `refs/tags/${tag}`], { capture: true, optional: true });
    if (existingTag.status !== 0) run('git', ['tag', tag]);
    else {
      const head = run('git', ['rev-parse', 'HEAD'], { capture: true }).stdout.trim();
      if (existingTag.stdout.trim() !== head) throw new Error('The existing version tag points to a different commit. It was not moved.');
    }
    run('git', ['push', 'origin', tag]);
    console.log(`Published ${target}. The repository is ${values.public ? 'public' : 'private'}. No npm registry publication was performed.`);
  }
} catch (error) {
  console.error(`Publish stopped: ${error.message}\nInstall GitHub CLI and run gh auth login when authentication is missing. Never paste a token into a source file.`);
  process.exitCode = 1;
}
