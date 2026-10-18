import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_CONTENT_BYTES = 256 * 1024;
const MAX_WALK_ENTRIES = 20000;
const MAX_DEPTH = 24;
const PROTECTED_NAMES = new Set([
  '.git', '.env', '.envrc', 'node_modules', '.ssh', '.aws', '.azure', '.gnupg', '.gcloud',
  '.npmrc', '.netrc', '.pypirc', '.git-credentials', '.gitconfig', '.docker',
  '.kube', '.config', '.zai', '.zai-cli', '.zai-workbench', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
]);
const integer = (description, minimum, maximum) => ({ type: 'integer', description, minimum, maximum });
const string = (description) => ({ type: 'string', description });
const definition = (name, description, properties, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
});

export const TOOL_DEFINITIONS = [
  definition('list_files', 'List approved workspace paths. Protected paths and symlinks are excluded.', {
    path: string('Workspace-relative directory, defaults to .'),
    recursive: { type: 'boolean', description: 'Include subdirectories, defaults to false' },
    max_entries: integer('Maximum returned entries, defaults to 200', 1, 1000),
  }),
  definition('read_file', 'Read approved UTF-8 text from the workspace. File content is sent to the model.', {
    path: string('Workspace-relative file path'),
    start_line: integer('First line, starting at 1', 1, 1000000),
    max_lines: integer('Maximum lines, defaults to 200', 1, 2000),
    max_bytes: integer('Maximum returned UTF-8 bytes, defaults to 32768', 1, MAX_CONTENT_BYTES),
  }, ['path']),
  definition('search', 'Search approved workspace text for a literal string. Results are bounded; no regular expressions.', {
    query: string('Nonempty literal search string'),
    path: string('Workspace-relative directory or file, defaults to .'),
    case_sensitive: { type: 'boolean', description: 'Defaults to false' },
    max_results: integer('Maximum matching lines, defaults to 50', 1, 200),
  }, ['query']),
  definition('write_file', 'Create a text file after preview and approval. Replacing a file requires overwrite=true and a separate approved read for the preview.', {
    path: string('Workspace-relative file path'),
    content: string('Complete new UTF-8 contents, at most 256 KiB'),
    overwrite: { type: 'boolean', description: 'Explicitly allow replacing an existing file, defaults to false' },
  }, ['path', 'content']),
  definition('edit_file', 'Replace exactly one occurrence of old_text after an approved read, change preview, and write approval.', {
    path: string('Workspace-relative file path'),
    old_text: string('Nonempty text that must match exactly once'),
    new_text: string('Replacement text'),
  }, ['path', 'old_text', 'new_text']),
  definition('run_command', 'Run an explicitly approved shell command. There is NO OS sandbox: commands can access files outside the workspace and the network.', {
    command: string('Exact shell command to preview and approve'),
    cwd: string('Workspace-relative working directory, defaults to .'),
    timeout_ms: integer('Wall-clock timeout in milliseconds, defaults to 10000', 1, 60000),
    max_output_bytes: integer('Combined stdout/stderr byte cap, defaults to 32768; exceeding it stops the command', 1, 131072),
  }, ['command']),
];

function protectedComponent(component) {
  const name = component.toLowerCase();
  return PROTECTED_NAMES.has(name) || name.startsWith('.env.') ||
    /(^|[._-])(secrets?|credentials?|tokens?|api[-_]?keys?|private[-_]?keys?)([._-]|$)/i.test(name) ||
    /\.(pem|key|p12|pfx|jks|keystore)$/i.test(name) ||
    /^(service[-_]?account|application_default_credentials)([._-]|$)/i.test(name);
}

function relativePath(value = '.') {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || value.includes('\0')) {
    throw new Error('Path must be a nonempty workspace-relative string.');
  }
  if (path.isAbsolute(value) || value.includes(':') || value.includes('\\')) {
    throw new Error('Absolute paths, colons, and backslashes are not allowed. Use workspace-relative paths.');
  }
  const parts = value.split('/').filter((part) => part && part !== '.');
  if (parts.includes('..')) throw new Error('Path traversal outside the workspace is not allowed.');
  if (parts.some((part) => /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error('Reserved device names and paths ending in a dot or space are not allowed.');
  }
  if (parts.some(protectedComponent)) throw new Error('Protected paths cannot be accessed by workspace tools.');
  return parts.length ? parts.join('/') : '.';
}

function boundedInteger(value, fallback, minimum, maximum, name) {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < minimum || result > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return result;
}

function textArgument(value, name, { empty = true, max = MAX_CONTENT_BYTES } = {}) {
  if (typeof value !== 'string' || (!empty && !value.length) || Buffer.byteLength(value, 'utf8') > max) {
    throw new Error(`${name} must be ${empty ? 'a' : 'a nonempty'} string of at most ${max} UTF-8 bytes.`);
  }
  if (value.includes('\0')) throw new Error(`${name} must not contain NUL bytes.`);
  return value;
}

function booleanArgument(value, fallback, name) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean.`);
  return value;
}

function abortError() {
  const error = new Error('Operation cancelled.');
  error.name = 'AbortError';
  return error;
}

function truncateUtf8(text, bytes) {
  const buffer = Buffer.from(text);
  if (buffer.length <= bytes) return text;
  let end = bytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString('utf8');
}

function commandEnvironment() {
  // An allowlist avoids accidentally forwarding newly introduced API keys or tokens.
  const result = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'COMSPEC', 'PATHEXT', 'WINDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM']) {
    if (process.env[key] !== undefined) result[key] = process.env[key];
  }
  result.NO_COLOR = '1';
  return result;
}

/** Workspace helpers are guardrails, not an OS security boundary. Symlinks are deliberately never followed. */
export function createTools({ cwd = process.cwd(), approve = async () => false, signal } = {}) {
  if (typeof approve !== 'function') throw new TypeError('approve must be a function.');
  const configuredRoot = path.resolve(cwd);
  let rootPromise;
  const root = () => (rootPromise ??= fs.realpath(configuredRoot));
  const checkAbort = () => { if (signal?.aborted) throw abortError(); };

  async function permission(kind, summary, details) {
    checkAbort();
    if ((await approve({ kind, summary, details })) !== true) throw new Error(`Permission denied: ${summary}`);
    checkAbort();
  }

  async function resolveSafe(relative, { missing = false } = {}) {
    checkAbort();
    const workspace = await root();
    const parts = relative === '.' ? [] : relative.split('/');
    let current = workspace;
    let lastStat = await fs.lstat(workspace);
    if (!lastStat.isDirectory()) throw new Error('The workspace must be a directory.');
    for (let index = 0; index < parts.length; index += 1) {
      current = path.join(current, parts[index]);
      try {
        lastStat = await fs.lstat(current);
      } catch (error) {
        if (missing && error.code === 'ENOENT') return { absolute: path.join(workspace, ...parts), stat: null };
        throw error;
      }
      if (lastStat.isSymbolicLink()) throw new Error('Symlinks cannot be accessed by workspace tools.');
      if (index < parts.length - 1 && !lastStat.isDirectory()) throw new Error('A parent path is not a directory.');
    }
    // This also catches some concurrent directory substitutions. No filesystem-only check is an OS sandbox.
    const actual = await fs.realpath(current);
    if (actual !== workspace && !actual.startsWith(`${workspace}${path.sep}`)) throw new Error('Path escapes the workspace.');
    const actualRelative = path.relative(workspace, actual);
    if (actualRelative.split(path.sep).some(protectedComponent)) throw new Error('Protected paths cannot be accessed.');
    return { absolute: current, stat: lastStat };
  }

  async function readBytes(relative, maximum, { complete = false } = {}) {
    const { absolute, stat } = await resolveSafe(relative);
    if (!stat.isFile()) throw new Error('Expected a regular file.');
    if (stat.nlink > 1) throw new Error('Files with multiple hard links cannot be accessed.');
    const handle = await fs.open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const current = await handle.stat();
      if (!current.isFile() || current.nlink > 1) throw new Error('Expected a regular file without hard links.');
      if (complete && current.size > maximum) throw new Error(`File exceeds the ${maximum}-byte edit/preview limit.`);
      const buffer = Buffer.alloc(Math.min(current.size, maximum) + 1);
      let total = 0;
      while (total < buffer.length) {
        checkAbort();
        const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
        if (!bytesRead) break;
        total += bytesRead;
      }
      if (complete && total > maximum) throw new Error('File grew beyond the edit/preview limit.');
      const bytes = buffer.subarray(0, Math.min(total, maximum));
      if (bytes.includes(0)) throw new Error('Binary files are not supported.');
      const truncated = total > maximum || current.size > maximum;
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes, { stream: truncated }); }
      catch { throw new Error('Only valid UTF-8 text files are supported.'); }
      return { bytes, text, truncated, stat: current };
    } finally {
      await handle.close();
    }
  }

  async function* walk(relative, recursive, state) {
    const pending = [{ relative, depth: 0 }];
    while (pending.length) {
      checkAbort();
      const item = pending.pop();
      const { absolute, stat } = await resolveSafe(item.relative);
      if (!stat.isDirectory()) throw new Error('Expected a directory.');
      const directory = await fs.opendir(absolute);
      for await (const entry of directory) {
        checkAbort();
        state.visited += 1;
        if (state.visited > MAX_WALK_ENTRIES) { state.truncated = true; return; }
        if (protectedComponent(entry.name) || entry.isSymbolicLink()) continue;
        if (!entry.isFile() && !entry.isDirectory()) continue;
        const child = item.relative === '.' ? entry.name : `${item.relative}/${entry.name}`;
        yield { path: child, type: entry.isDirectory() ? 'directory' : 'file' };
        if (entry.isDirectory() && recursive) {
          if (item.depth >= MAX_DEPTH) state.truncated = true;
          else pending.push({ relative: child, depth: item.depth + 1 });
        }
      }
    }
  }

  async function commitFile(relative, content, expected) {
    checkAbort();
    const { absolute } = await resolveSafe(relative, { missing: true });
    const parentRelative = path.posix.dirname(relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await resolveSafe(parentRelative);
    const temporary = path.join(path.dirname(absolute), `.zai-write-${randomUUID()}.tmp`);
    let created = false;
    try {
      const handle = await fs.open(temporary, 'wx', expected ? expected.stat.mode & 0o777 : 0o600);
      created = true;
      try {
        await handle.writeFile(content, 'utf8');
        await handle.sync();
      } finally { await handle.close(); }
      checkAbort();
      await resolveSafe(parentRelative);
      if (expected) {
        const now = await readBytes(relative, MAX_CONTENT_BYTES, { complete: true });
        if (now.stat.ino !== expected.stat.ino || now.stat.dev !== expected.stat.dev || !now.bytes.equals(expected.bytes)) {
          throw new Error('File changed after the preview. Review and approve a fresh change.');
        }
        await fs.rename(temporary, absolute);
        created = false;
      } else {
        // link is an atomic create-only operation, so a concurrent file is never overwritten.
        await resolveSafe(relative, { missing: true });
        await fs.link(temporary, absolute);
        await fs.unlink(temporary);
        created = false;
      }
      return { path: relative, bytes_written: Buffer.byteLength(content), created: !expected };
    } finally {
      if (created) await fs.unlink(temporary).catch(() => {});
    }
  }

  async function runCommand(args) {
    const command = textArgument(args.command, 'command', { empty: false, max: 8192 });
    const relative = relativePath(args.cwd);
    const timeout = boundedInteger(args.timeout_ms, 10000, 1, 60000, 'timeout_ms');
    const maxOutput = boundedInteger(args.max_output_bytes, 32768, 1, 131072, 'max_output_bytes');
    await permission('exec', `Run shell command in ${relative}`, [
      'WARNING: There is no OS sandbox. This command can read or change files outside the workspace, access local credentials, and use the network.',
      'Only a small environment allowlist is inherited. This does not prevent access to credentials on disk.',
      `Timeout: ${timeout} ms. Combined output cap: ${maxOutput} bytes.`,
      'Command output will be sent to the model. Process-tree termination is best-effort on Windows.',
      '', command,
    ].join('\n'));
    const { absolute, stat } = await resolveSafe(relative);
    if (!stat.isDirectory()) throw new Error('Command cwd must be a directory.');
    checkAbort();
    return new Promise((resolve, reject) => {
      const child = spawn(command, { cwd: absolute, shell: true, env: commandEnvironment(), detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      const stdout = [];
      const stderr = [];
      let total = 0;
      let stopReason = null;
      let finished = false;
      let killTimer;
      let fallbackTimer;
      let pendingClose;
      const terminate = (sig) => {
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, sig);
          else child.kill(sig);
        } catch (error) { if (error.code !== 'ESRCH') child.kill(sig); }
      };
      const finish = (code, childSignal, error) => {
        if (finished) return;
        // Even if the shell closes its pipes, finish group cleanup before returning.
        if (stopReason && killTimer) { pendingClose = [code, childSignal, error]; return; }
        finished = true;
        clearTimeout(timer);
        clearTimeout(killTimer);
        clearTimeout(fallbackTimer);
        signal?.removeEventListener('abort', onAbort);
        if (error && !stopReason) { reject(error); return; }
        resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), exit_code: code ?? null, signal: childSignal ?? null, timed_out: stopReason === 'timeout', cancelled: stopReason === 'cancelled', output_truncated: stopReason === 'output_limit' });
      };
      const stop = (reason) => {
        if (finished || stopReason) return;
        stopReason = reason;
        terminate('SIGTERM');
        killTimer = setTimeout(() => {
          terminate('SIGKILL');
          killTimer = null;
          if (pendingClose) finish(...pendingClose);
        }, 200);
        fallbackTimer = setTimeout(() => {
          terminate('SIGKILL');
          child.stdout.destroy();
          child.stderr.destroy();
          finish(null, 'SIGKILL');
        }, 1000);
      };
      const capture = (target, chunk) => {
        const remaining = maxOutput - total;
        if (remaining > 0) {
          const accepted = chunk.subarray(0, remaining);
          target.push(accepted);
          total += accepted.length;
        }
        if (chunk.length > remaining) stop('output_limit');
      };
      const onAbort = () => stop('cancelled');
      const timer = setTimeout(() => stop('timeout'), timeout);
      child.stdout.on('data', (chunk) => capture(stdout, chunk));
      child.stderr.on('data', (chunk) => capture(stderr, chunk));
      child.once('error', (error) => finish(null, null, error));
      child.once('close', (code, childSignal) => finish(code, childSignal));
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  async function execute(name, args = {}) {
    checkAbort();
    const tool = TOOL_DEFINITIONS.find((entry) => entry.function.name === name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object.');
    const allowed = Object.keys(tool.function.parameters.properties);
    for (const key of Object.keys(args)) if (!allowed.includes(key)) throw new Error(`Unknown argument for ${name}: ${key}`);
    for (const key of tool.function.parameters.required) if (args[key] === undefined) throw new Error(`Missing required argument: ${key}`);
    if (name === 'run_command') return runCommand(args);
    const relative = relativePath(args.path);

    if (name === 'list_files') {
      const recursive = booleanArgument(args.recursive, false, 'recursive');
      const maximum = boundedInteger(args.max_entries, 200, 1, 1000, 'max_entries');
      await permission('read', `List ${relative}${recursive ? ' recursively' : ''}`, 'Workspace file names will be sent to the model. Protected paths and symlinks are excluded.');
      const entries = [];
      const state = { visited: 0, truncated: false };
      for await (const entry of walk(relative, recursive, state)) {
        if (entries.length === maximum) { state.truncated = true; break; }
        entries.push(entry);
      }
      entries.sort((a, b) => a.path.localeCompare(b.path));
      return { path: relative, entries, truncated: state.truncated };
    }

    if (name === 'read_file') {
      const startLine = boundedInteger(args.start_line, 1, 1, 1000000, 'start_line');
      const maxLines = boundedInteger(args.max_lines, 200, 1, 2000, 'max_lines');
      const maxBytes = boundedInteger(args.max_bytes, 32768, 1, MAX_CONTENT_BYTES, 'max_bytes');
      await permission('read', `Read ${relative}`, `File content will be sent to the model. Starting at line ${startLine}, at most ${maxLines} lines and ${maxBytes} output bytes. Only the first ${MAX_FILE_BYTES} bytes are scanned.`);
      const data = await readBytes(relative, MAX_FILE_BYTES);
      const lines = data.text.split('\n');
      if (data.text.endsWith('\n')) lines.pop();
      const selected = lines.slice(startLine - 1, startLine - 1 + maxLines).join('\n');
      const content = truncateUtf8(selected, maxBytes);
      return { path: relative, start_line: startLine, content, truncated: data.truncated || lines.length > startLine - 1 + maxLines || content !== selected };
    }

    if (name === 'search') {
      const query = textArgument(args.query, 'query', { empty: false, max: 4096 });
      if (query.includes('\n') || query.includes('\r')) throw new Error('Search query must fit on one line.');
      const caseSensitive = booleanArgument(args.case_sensitive, false, 'case_sensitive');
      const maximum = boundedInteger(args.max_results, 50, 1, 200, 'max_results');
      await permission('read', `Search ${relative} for ${JSON.stringify(query)}`, `Matching file paths and line excerpts will be sent to the model. At most ${maximum} matches; protected paths, symlinks, binary files, and files over ${MAX_FILE_BYTES} bytes are excluded.`);
      const { stat } = await resolveSafe(relative);
      const state = { visited: 0, truncated: false };
      const entries = stat.isFile() ? [{ path: relative, type: 'file' }] : walk(relative, true, state);
      const matches = [];
      let scannedFiles = 0;
      let skippedFiles = 0;
      const needle = caseSensitive ? query : query.toLowerCase();
      outer: for await (const entry of entries) {
        if (entry.type !== 'file') continue;
        if (scannedFiles >= 1000) { state.truncated = true; break; }
        scannedFiles += 1;
        let data;
        try { data = await readBytes(entry.path, MAX_FILE_BYTES, { complete: true }); }
        catch (error) {
          if (error.name === 'AbortError') throw error;
          skippedFiles += 1;
          continue;
        }
        const lines = data.text.split('\n');
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index];
          const searchable = caseSensitive ? line : line.toLowerCase();
          const found = searchable.indexOf(needle);
          if (found === -1) continue;
          if (matches.length === maximum) { state.truncated = true; break outer; }
          const offset = Math.max(0, found - 100);
          const excerpt = truncateUtf8(line.slice(offset), 500);
          matches.push({ path: entry.path, line: index + 1, text: `${offset ? '...' : ''}${excerpt}`, truncated: offset > 0 || excerpt.length < line.length - offset });
        }
      }
      return { query, matches, scanned_files: scannedFiles, skipped_files: skippedFiles, truncated: state.truncated };
    }

    if (relative === '.') throw new Error('A file path is required.');
    if (name === 'write_file') {
      const content = textArgument(args.content, 'content');
      const overwrite = booleanArgument(args.overwrite, false, 'overwrite');
      const target = await resolveSafe(relative, { missing: true });
      let previous;
      if (target.stat) {
        if (!target.stat.isFile()) throw new Error('Expected a regular file.');
        if (!overwrite) throw new Error('File already exists. Use edit_file or set overwrite=true to request a reviewed replacement.');
        await permission('read', `Read ${relative} to prepare a replacement preview`, 'Read the current file locally so the user can review the full before/after preview.');
        previous = await readBytes(relative, MAX_CONTENT_BYTES, { complete: true });
      }
      await permission('write', `${previous ? 'Replace' : 'Create'} ${relative}`, `${previous ? `BEFORE\n${previous.text}\n\n` : ''}AFTER\n${content}\n\nComplete preview. New size: ${Buffer.byteLength(content)} bytes.`);
      return commitFile(relative, content, previous);
    }

    const oldText = textArgument(args.old_text, 'old_text', { empty: false });
    const newText = textArgument(args.new_text, 'new_text');
    await permission('read', `Read ${relative} to prepare an edit preview`, 'Read the current file locally to verify one exact match and prepare the change for user review.');
    const previous = await readBytes(relative, MAX_CONTENT_BYTES, { complete: true });
    const index = previous.text.indexOf(oldText);
    if (index < 0) throw new Error('old_text was not found. No file was changed.');
    if (previous.text.indexOf(oldText, index + 1) >= 0) throw new Error('old_text matches more than once. Include enough context for a unique match.');
    const content = previous.text.slice(0, index) + newText + previous.text.slice(index + oldText.length);
    textArgument(content, 'resulting content');
    await permission('write', `Edit ${relative}`, `Replace exactly one occurrence.\n\nREMOVE\n${oldText}\n\nINSERT\n${newText}\n\nComplete change preview. New size: ${Buffer.byteLength(content)} bytes.`);
    return commitFile(relative, content, previous);
  }

  return { execute };
}
