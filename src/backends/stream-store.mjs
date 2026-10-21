import { mkdir, open, readdir, unlink, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { stateDir } from '../config.mjs';
import { id, hash, isRecord, readJson, writeJson, redact } from '../util.mjs';
import { STREAM_POLICY, validStreamSession } from './stream-contract.mjs';
const LOCAL_ID = /^[a-f0-9-]{36}$/;

/** Display history and an upstream ID only. Never a provider credential store. */
export class StreamStore {
  constructor(cwd, runtime, home = stateDir()) {
    this.cwd = cwd; this.runtimeIdentity = hash(JSON.stringify(runtime));
    this.directory = join(home, 'stream-sessions', hash(cwd).slice(0, 24));
  }
  path(localId) {
    if (!LOCAL_ID.test(localId)) throw new Error('Use an exact local session ID from /sessions.');
    return join(this.directory, localId + '.json');
  }
  create(model) {
    return { version: 1, backend: 'native-stream', policy: STREAM_POLICY, id: id(), cwd: this.cwd,
      runtimeIdentity: this.runtimeIdentity, model, entries: [], updatedAt: Date.now(), title: '', status: 'new' };
  }
  async acquire(localId) {
    const lockPath = this.path(localId) + '.lock';
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let file;
    try { file = await open(lockPath, 'wx', 0o600); }
    catch (error) {
      if (error.code === 'EEXIST') throw new Error(`This stream session is locked by another or interrupted ZC process. Inspect ${lockPath} locally. Do not remove it while that process is running.`);
      throw error;
    }
    try { await file.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now(), sessionId: localId }) + '\n'); await file.sync(); }
    catch (error) { await file.close(); await unlink(lockPath).catch(() => {}); throw error; }
    const owned = await file.stat();
    let released = false;
    return async () => {
      if (released) return; released = true; await file.close();
      try {
        const current = await lstat(lockPath);
        if (current.isSymbolicLink() || current.dev !== owned.dev || current.ino !== owned.ino) throw new Error('The stream session lock was replaced. The replacement was not removed.');
        await unlink(lockPath);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    };
  }
  async load(localId) {
    const s = await readJson(this.path(localId), null, 4 * 1024 * 1024);
    if (!isRecord(s) || s.version !== 1 || s.backend !== 'native-stream' || s.id !== localId || s.cwd !== this.cwd ||
      s.policy !== STREAM_POLICY || s.runtimeIdentity !== this.runtimeIdentity || !Array.isArray(s.entries) || s.entries.length > 400 ||
      (s.nativeSessionId !== undefined && !validStreamSession(s.nativeSessionId)) || typeof s.model !== 'string' ||
      s.entries.some(e => !isRecord(e) || !['user', 'assistant', 'tool', 'notice', 'error'].includes(e.role) || typeof e.id !== 'string')) {
      throw new Error('Stream session is missing or incompatible with this workspace, runtime, or policy.');
    }
    return s;
  }
  async save(s) {
    if (s.cwd !== this.cwd || s.runtimeIdentity !== this.runtimeIdentity) throw new Error('Cannot save a stream session outside its scope.');
    const encoded = JSON.stringify(s, (_, value) => typeof value === 'string' ? redact(value) : value);
    if (Buffer.byteLength(encoded) > 4 * 1024 * 1024) throw new Error('Stream display history exceeded its storage budget.');
    await writeJson(this.path(s.id), JSON.parse(encoded));
  }
  async list() {
    let files;
    try { files = await readdir(this.directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const rows = [];
    for (const file of files.filter(f => f.endsWith('.json') && LOCAL_ID.test(f.slice(0, -5))).slice(0, 500)) {
      try { const s = await this.load(file.slice(0, -5)); rows.push({ id: s.id, title: redact(s.title || 'New stream session'), updatedAt: s.updatedAt }); }
      catch { /* Incompatible records do not become selectable sessions. */ }
    }
    return rows.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 50);
  }
}
