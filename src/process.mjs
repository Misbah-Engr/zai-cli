import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, join, isAbsolute } from 'node:path';
import { abortError, throwIfAborted } from './util.mjs';

export async function executableExists(command) {
  const suffixes = process.platform === 'win32' ? ['', ...(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')] : [''];
  const bases = isAbsolute(command) || command.includes('/') || command.includes('\\') ? [''] : (process.env.PATH || '').split(delimiter);
  for (const base of bases) for (const suffix of suffixes) {
    try { await access(base ? join(base, command + suffix) : command + suffix, process.platform === 'win32' ? constants.F_OK : constants.X_OK); return true; }
    catch { /* Try the next PATH entry. */ }
  }
  return false;
}
export function spawnProcess(command, args, options = {}) {
  // No shell interpolation in protocol, Git, or publisher paths.
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    throw new Error('Batch shims cannot be used as runtime executables. Configure the absolute .cjs bundle with `zc config runtime <path>`.');
  }
  return spawn(command, args, { windowsHide: true, shell: false, ...options });
}
export async function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    await new Promise(resolve => {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', () => { child.kill(); resolve(); });
      killer.once('close', resolve);
    });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* Already gone. */ } }
  }
}
export function runProcess(command, args, { cwd, env = process.env, signal, timeout = 30000, maxBytes = 64000, shell = false } = {}) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', bytes = 0, truncated = false, timedOut = false, aborted = false, done = false;
    const collect = chunk => {
      const remaining = Math.max(0, maxBytes - bytes);
      if (remaining) output += chunk.subarray(0, remaining).toString('utf8');
      bytes += chunk.length;
      if (bytes > maxBytes) truncated = true;
    };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    const terminate = () => { void killTree(child); };
    const onAbort = () => { aborted = true; terminate(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const timer = setTimeout(() => { timedOut = true; terminate(); }, timeout);
    const finish = (error, code, childSignal) => {
      if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
      if (aborted) return reject(abortError());
      if (error) return reject(error);
      resolve({ code, signal: childSignal, output, truncated, timedOut });
    };
    child.once('error', error => finish(error));
    child.once('close', (code, childSignal) => finish(null, code, childSignal));
  });
}
