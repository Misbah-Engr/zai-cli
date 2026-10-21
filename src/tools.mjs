import { lstat, realpath, readdir, readFile, mkdir, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve, relative, dirname, sep, isAbsolute } from 'node:path';
import { atomicWrite, hash, bounded, throwIfAborted, isRecord } from './util.mjs';
import { runProcess } from './process.mjs';
import { stateDir } from './config.mjs';

const OMIT_DIRS = new Set(['.git', '.hg', '.svn', 'node_modules', '.venv', 'venv', '__pycache__', '.next', 'dist', 'build', 'coverage', '.terraform']);
const PRIVATE_FILES = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|credentials(?:\.json)?|id_(?:rsa|ed25519|ecdsa|dsa)(?:\.pub)?|.*\.(?:pem|key|p12|pfx)|wallet\.dat)$/i;
const PRIVATE_DIRS = new Set(['.ssh', '.aws', '.azure', '.gnupg', '.zcode', '.zc']);
const LIMIT = 512 * 1024;
const parameters = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const string = description => ({ type: 'string', description });
export const TOOL_DEFINITIONS = [
  { name: 'list_files', description: 'List project files. Git ignored files and sensitive paths are omitted. Paths are workspace-relative.', parameters: parameters({ path: string('Directory, or . for the workspace root') }) },
  { name: 'read_file', description: 'Read numbered source lines and get the full-file SHA-256 needed for a later exact edit.', parameters: parameters({ path: string('Workspace-relative file'), start_line: { type: 'integer', minimum: 1 }, max_lines: { type: 'integer', minimum: 1, maximum: 400 } }) },
  { name: 'search', description: 'Literal text search in project files, not a regular expression. Results are bounded.', parameters: parameters({ query: string('Literal search text'), path: string('Workspace-relative directory') }) },
  { name: 'create_file', description: 'Create a new text file after explicit user approval. Never overwrites an existing file.', parameters: parameters({ path: string('Workspace-relative file'), content: string('Complete UTF-8 contents') }) },
  { name: 'edit_file', description: 'Replace exactly one occurrence after approval. Read the file first and supply its unchanged SHA-256.', parameters: parameters({ path: string('Workspace-relative file'), expected_sha256: string('SHA-256 returned by read_file'), old_text: string('Unique, nonempty exact text to replace'), new_text: string('Replacement text') }) },
  { name: 'shell', description: 'Run an approved command in the workspace. Always asks the user. No OS sandbox. Do not work around denied tools.', parameters: parameters({ command: string('Exact shell command shown to the user'), timeout_ms: { type: 'integer', minimum: 100, maximum: 120000 } }) },
].map(fn => ({ type: 'function', function: fn }));

export function privatePath(path) {
  return path.replace(/\\/g, '/').split('/').some(part => OMIT_DIRS.has(part.toLowerCase()) || PRIVATE_DIRS.has(part.toLowerCase()) || PRIVATE_FILES.test(part));
}
export async function safePath(root, requested, { missing = false } = {}) {
  if (typeof requested !== 'string' || !requested || requested.length > 2048 || /[\0\r\n:]/.test(requested) || isAbsolute(requested) || /^[\\/]/.test(requested)) throw new Error('Use a relative path inside the workspace.');
  const parts = requested.replace(/\\/g, '/').split('/').filter(part => part && part !== '.');
  if (parts.some(part => part === '..' || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) throw new Error('Unsafe path component.');
  if (privatePath(parts.join('/'))) throw new Error('This path is excluded by the built-in privacy policy.');
  const canonicalRoot = await realpath(root);
  let current = canonicalRoot;
  const privateState = resolve(stateDir());
  if (current === privateState || current.startsWith(privateState + sep)) throw new Error('ZC state is not available to agent tools.');
  for (const part of parts) {
    current = join(current, part);
    if (current === privateState || current.startsWith(privateState + sep)) throw new Error('ZC state is not available to agent tools.');
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new Error('Symbolic links are not followed by built-in file tools.');
      if (!stat.isFile() && !stat.isDirectory()) throw new Error('Only regular files and directories are supported.');
      if (stat.isFile() && stat.nlink > 1) throw new Error('Hard-linked files are not accessible through built-in file tools.');
    } catch (error) { if (!(missing && error.code === 'ENOENT')) throw error; }
  }
  const rel = relative(canonicalRoot, current);
  if (rel.startsWith('..' + sep) || rel === '..' || isAbsolute(rel)) throw new Error('Path escapes the workspace.');
  return current;
}
export async function readText(root, path) {
  const absolute = await safePath(root, path);
  const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink > 1) throw new Error('Expected an unlinked regular source file.');
    if (stat.size > LIMIT) throw new Error(`File exceeds the ${LIMIT / 1024} KiB read limit.`);
    const content = await handle.readFile();
    if (content.length > LIMIT || content.includes(0)) throw new Error('File is too large or binary.');
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(content), sha256: hash(content), mode: stat.mode & 0o777, absolute };
  } finally { await handle.close(); }
}
export async function projectFiles(root, directory = '.', signal) {
  // Keep one canonical root for validation, Git, and relative-path projection.
  // An aliased ancestor (such as macOS /var) is not a link inside the workspace.
  const canonicalRoot = await realpath(root);
  const base = await safePath(canonicalRoot, directory);
  if (!(await lstat(base)).isDirectory()) throw new Error('Expected a directory.');
  let paths;
  try {
    const result = await runProcess('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: canonicalRoot, signal, maxBytes: 2 * 1024 * 1024 });
    if (result.code === 0 && !result.timedOut) paths = result.output.split('\0').filter(Boolean);
  } catch (error) { if (error.name === 'AbortError') throw error; }
  const prefix = relative(canonicalRoot, base).split(sep).join('/');
  if (paths) return [...new Set(paths)].filter(path => !privatePath(path) && (!prefix || path === prefix || path.startsWith(prefix + '/'))).sort().slice(0, 3000);
  paths = [];
  async function walk(dir, depth) {
    throwIfAborted(signal);
    if (depth > 20 || paths.length >= 3000) return;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a,b) => a.name.localeCompare(b.name))) {
      if (paths.length >= 3000) break;
      const full = join(dir, entry.name), rel = relative(canonicalRoot, full).split(sep).join('/');
      if (privatePath(rel) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.isFile()) paths.push(rel);
    }
  }
  await walk(base, 0); return paths;
}
export function changePreview(path, before, after) {
  const a = before.split('\n'), b = after.split('\n'); let start = 0, end = 0;
  while (start < Math.min(a.length, b.length) && a[start] === b[start]) start++;
  while (end < Math.min(a.length, b.length) - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const contextStart = Math.max(0, start - 3);
  const rows = [`--- a/${path}`, `+++ b/${path}`, `@@ line ${start + 1} @@`,
    ...a.slice(contextStart, start).map(line => ' ' + line),
    ...a.slice(start, a.length - end).map(line => '-' + line),
    ...b.slice(start, b.length - end).map(line => '+' + line),
    ...b.slice(b.length - end, Math.min(b.length, b.length - end + 3)).map(line => ' ' + line)];
  return bounded(rows.join('\n'), 32000);
}
function validateArguments(name, args) {
  const schema = TOOL_DEFINITIONS.find(def => def.function.name === name)?.function.parameters;
  if (!schema) throw new Error(`Unknown tool: ${name}`);
  if (!isRecord(args)) throw new Error('Tool arguments must be an object.');
  for (const key of Object.keys(args)) if (!schema.properties[key]) throw new Error(`Unexpected tool argument: ${key}`);
  for (const [key, property] of Object.entries(schema.properties)) {
    if (property.type === 'string' && (typeof args[key] !== 'string' || args[key].includes('\0') || Buffer.byteLength(args[key]) > LIMIT)) throw new Error(`Invalid ${key}.`);
    if (property.type === 'integer' && (!Number.isInteger(args[key]) || args[key] < property.minimum || args[key] > (property.maximum || 1000000))) throw new Error(`Invalid ${key}.`);
  }
}
export function childEnvironment(env = process.env) {
  const allowed = /^(?:PATH|HOME|USER|USERNAME|USERPROFILE|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|TMPDIR|LANG|LC_[A-Z_]+|TERM|COLORTERM|APPDATA|LOCALAPPDATA)$/i;
  return Object.fromEntries(Object.entries(env).filter(([key]) => allowed.test(key)));
}
export class Tools {
  constructor({ cwd, mode, ask, emit }) { this.cwd = cwd; this.mode = mode; this.ask = ask; this.emit = emit; }
  definitions() { return this.mode === 'read-only' ? TOOL_DEFINITIONS.slice(0, 3) : TOOL_DEFINITIONS; }
  async execute(name, args, signal) {
    throwIfAborted(signal); validateArguments(name, args);
    if (['create_file', 'edit_file', 'shell'].includes(name) && this.mode === 'read-only') throw new Error('Read-only mode blocks edits and all shell commands, including tests.');
    if (name === 'read_file') {
      const file = await readText(this.cwd, args.path);
      const lines = file.text.split('\n');
      return `SHA256: ${file.sha256}\nLines: ${lines.length}\n` + lines.slice(args.start_line - 1, args.start_line - 1 + args.max_lines).map((line,i) => `${args.start_line + i}: ${line}`).join('\n');
    }
    if (name === 'list_files') {
      const files = await projectFiles(this.cwd, args.path, signal);
      return files.slice(0, 500).join('\n') + (files.length >= 500 ? '\n[Listing limited to 500 files.]' : '');
    }
    if (name === 'search') {
      if (!args.query || args.query.length > 1000) throw new Error('Search text must contain 1 to 1000 characters.');
      const files = await projectFiles(this.cwd, args.path, signal), hits = []; let bytes = 0;
      for (const path of files) {
        throwIfAborted(signal); if (bytes >= 12 * 1024 * 1024 || hits.length >= 100) break;
        try {
          const { text } = await readText(this.cwd, path); bytes += text.length;
          text.split('\n').forEach((line, i) => { if (hits.length < 100 && line.includes(args.query)) hits.push(`${path}:${i + 1}: ${line.slice(0, 500)}`); });
        } catch (error) { if (error.name === 'AbortError') throw error; }
      }
      return (hits.join('\n') || 'No matches in the scanned files.') + '\n[Search limits: 3000 paths, 12 MiB, 100 matches. Excluded and unreadable files are skipped.]';
    }
    if (name === 'shell') {
      if (!args.command.trim() || args.command.length > 12000) throw new Error('Command must contain 1 to 12000 characters.');
      const allow = await this.ask({ title: 'Run this command?', detail: 'Runs with your user permissions, outside an OS sandbox. It may access the network or files beyond this project.', input: args.command, risk: 'high' }, signal);
      if (!allow) throw new Error('User denied this command. Do not work around this denial.');
      throwIfAborted(signal);
      const result = await runProcess(args.command, [], { cwd: this.cwd, shell: true, env: childEnvironment(), signal, timeout: args.timeout_ms });
      return `Exit: ${result.code ?? result.signal}\n${result.output}${result.truncated ? '\n[Output truncated.]' : ''}${result.timedOut ? '\n[Command exceeded its time limit and was terminated.]' : ''}`;
    }
    if (name === 'create_file') {
      const target = await safePath(this.cwd, args.path, { missing: true });
      try { await lstat(target); throw new Error('File already exists. Use read_file followed by edit_file.'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!(await this.ask({ title: `Create ${args.path}?`, detail: 'A new file will be written after approval.', input: changePreview(args.path, '', args.content), risk: 'medium' }, signal))) throw new Error('User denied the file creation.');
      throwIfAborted(signal);
      await safePath(this.cwd, args.path, { missing: true });
      await mkdir(dirname(target), { recursive: true });
      await safePath(this.cwd, args.path, { missing: true });
      const file = await open(target, 'wx', 0o644);
      try { await file.writeFile(args.content, 'utf8'); await file.sync(); } finally { await file.close(); }
      return `Created ${args.path}. SHA256: ${hash(args.content)}`;
    }
    if (name === 'edit_file') {
      const original = await readText(this.cwd, args.path);
      if (!/^[a-f0-9]{64}$/i.test(args.expected_sha256) || original.sha256 !== args.expected_sha256) throw new Error('File changed since it was read. Read it again before proposing an edit.');
      if (!args.old_text || original.text.indexOf(args.old_text) < 0 || original.text.indexOf(args.old_text) !== original.text.lastIndexOf(args.old_text)) throw new Error('old_text must match exactly one nonempty occurrence.');
      const updated = original.text.replace(args.old_text, () => args.new_text);
      if (Buffer.byteLength(updated) > LIMIT) throw new Error('Updated file exceeds the write limit.');
      if (updated === original.text) return 'No change needed.';
      if (!(await this.ask({ title: `Edit ${args.path}?`, detail: 'Review the exact change. Approval applies only to this version of the file.', input: changePreview(args.path, original.text, updated), risk: 'medium' }, signal))) throw new Error('User denied this edit.');
      throwIfAborted(signal);
      const latest = await readText(this.cwd, args.path);
      if (latest.sha256 !== original.sha256) throw new Error('File changed while approval was pending. Nothing was written.');
      await atomicWrite(latest.absolute, updated, latest.mode);
      return `Updated ${args.path}. SHA256: ${hash(updated)}`;
    }
    throw new Error('Tool not implemented.');
  }
}
