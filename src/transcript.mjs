import { mkdir, open, lstat, readFile, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { hash, redact, isRecord, id } from './util.mjs';
import { stateDir } from './config.mjs';

/** Local, visible transcript only. Append-only records keep older history off the screen heap. */
export class TranscriptJournal {
  constructor(file, handle, size = 0) {
    this.path = file; this.handle = handle; this.size = size;
    this.order = []; this.index = new Map(); this.dirty = new Map(); this.streaming = new Map(); this.chain = Promise.resolve();
  }
  static async open(cwd, sessionId, root = stateDir()) {
    const dir = join(root, 'transcripts', hash(cwd).slice(0, 24));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, hash(sessionId).slice(0, 40) + '.jsonl');
    try { const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Transcript path is not a regular file.'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const lockPath = path + '.lock', token = id();
    const acquire = async () => { const file = await open(lockPath, 'wx', 0o600); try { await file.writeFile(JSON.stringify({ pid: process.pid, token })); } finally { await file.close(); } };
    try { await acquire(); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const inspectLock = async () => {
        let stat;
        try { stat = await lstat(lockPath); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('Unsafe transcript lock path.');
        let lock;
        try { lock = JSON.parse(await readFile(lockPath, 'utf8')); } catch { throw new Error('Transcript lock is unreadable. No archive was modified.'); }
        if (!Number.isSafeInteger(lock.pid) || lock.pid <= 0 || typeof lock.token !== 'string') throw new Error('Transcript lock is invalid.');
        let alive = true;
        try { process.kill(lock.pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
        if (alive) throw new Error('This transcript is already open in another ZC process.');
        return lock;
      };
      await inspectLock();
      // Serialize stale-lock reclamation. A second reclaimer must not unlink the
      // fresh writer's lock after both observed the same dead process.
      const recoveryPath = lockPath + '.recovery';
      let recovery;
      try { recovery = await open(recoveryPath, 'wx', 0o600); }
      catch (e) { if (e.code === 'EEXIST') throw new Error('Transcript lock recovery is already in progress. No archive was modified.'); throw e; }
      try {
        await recovery.writeFile(JSON.stringify({ pid: process.pid, token }));
        const stale = await inspectLock();
        if (stale) await unlink(lockPath);
        try { await acquire(); }
        catch (e) { if (e.code === 'EEXIST') throw new Error('This transcript is already open in another ZC process.'); throw e; }
      } finally { await recovery.close(); await unlink(recoveryPath).catch(() => {}); }
    }
    let handle;
    try {
      handle = await open(path, 'a+', 0o600); const stat = await handle.stat();
      const journal = new TranscriptJournal(path, handle, stat.size);
      journal.lockPath = lockPath; journal.lockToken = token;
      await journal.reindex(); return journal;
    } catch (error) { await handle?.close(); await unlink(lockPath).catch(() => {}); throw error; }
  }
  async reindex() {
    let buffer = Buffer.alloc(0), offset = 0;
    for await (const chunk of createReadStream(this.path)) {
      buffer = Buffer.concat([buffer, chunk]);
      let newline;
      while ((newline = buffer.indexOf(10)) >= 0) {
        const bytes = buffer.subarray(0, newline), length = newline + 1;
        if (bytes.length > 1024 * 1024) throw new Error('Transcript record exceeds its size limit.');
        if (bytes.length) {
          const record = JSON.parse(bytes.toString('utf8'));
          if (!isRecord(record.entry) || typeof record.entry.id !== 'string') throw new Error('Transcript contains an invalid record. Original file was preserved.');
          if (!this.index.has(record.entry.id)) this.order.push(record.entry.id);
          this.index.set(record.entry.id, { offset, length, signature: hash(JSON.stringify(record.entry)) });
        }
        offset += length; buffer = buffer.subarray(length);
      }
      if (buffer.length > 1024 * 1024) throw new Error('Transcript record exceeds its size limit.');
    }
    if (buffer.length) {
      // A crash may interrupt the final append. Preserve the file, do not append onto an invalid tail.
      throw new Error('Transcript has an incomplete last record. Export/recover the original before appending.');
    }
  }
  stage(entry, transient = false) {
    if (this.closed || this.failure) return;
    const safe = JSON.parse(JSON.stringify(entry, (_, value) => typeof value === 'string' ? redact(value) : value));
    if (transient) {
      this.streaming.set(entry.id, safe);
      if (!this.streamTimer) this.streamTimer = setTimeout(() => { this.streamTimer = null; void this.flush().catch(error => { this.failure = error; this.onError?.(error); }); }, 15000);
      return;
    }
    this.streaming.delete(entry.id); this.dirty.set(entry.id, safe);
    if (!this.timer) this.timer = setTimeout(() => { this.timer = null; void this.flush(false).catch(error => { this.failure = error; this.onError?.(error); }); }, 250);
  }
  flush(checkpoint = true) {
    if (checkpoint) { clearTimeout(this.streamTimer); this.streamTimer = null; for (const [id, entry] of this.streaming) this.dirty.set(id, entry); this.streaming.clear(); }
    clearTimeout(this.timer); this.timer = null;
    const entries = [...this.dirty.values()]; this.dirty.clear();
    this.chain = this.chain.then(async () => {
      if (this.failure) throw this.failure;
      for (const entry of entries) {
        const signature = hash(JSON.stringify(entry));
        if (this.index.get(entry.id)?.signature === signature) continue;
        const bytes = Buffer.from(JSON.stringify({ entry }) + '\n');
        if (bytes.length > 1024 * 1024) throw new Error('Visible transcript entry is too large to archive.');
        const record = { offset: this.size, length: bytes.length, signature };
        // Handle partial writes explicitly rather than assuming one syscall writes the record.
        let written = 0;
        while (written < bytes.length) { const result = await this.handle.write(bytes, written, bytes.length - written, null); if (!result.bytesWritten) throw new Error('Transcript write made no progress.'); written += result.bytesWritten; }
        this.size += bytes.length;
        if (!this.index.has(entry.id)) this.order.push(entry.id);
        this.index.set(entry.id, record);
      }
    }).catch(error => { this.failure = error; throw error; });
    return this.chain;
  }
  async read(start = 0, count = 200) {
    await this.flush(); const entries = [];
    for (const key of this.order.slice(Math.max(0, start), Math.max(0, start) + count)) {
      const { offset, length } = this.index.get(key), buffer = Buffer.alloc(length);
      let read = 0;
      while (read < length) { const result = await this.handle.read(buffer, read, length - read, offset + read); if (!result.bytesRead) throw new Error('Incomplete transcript read.'); read += result.bytesRead; }
      entries.push(JSON.parse(buffer.toString('utf8')).entry);
    }
    return entries;
  }
  async window(anchor, direction = 'forward', maxEntries = 500, maxBytes = 1500000) {
    await this.flush();
    anchor = Math.max(0, Math.min(this.order.length, anchor));
    let start = anchor, end = anchor, bytes = 0;
    if (direction === 'backward') {
      while (start > 0 && end - start < maxEntries) {
        const next = this.index.get(this.order[start - 1]).length;
        if (bytes && bytes + next > maxBytes) break;
        start--; bytes += next;
      }
    } else {
      while (end < this.order.length && end - start < maxEntries) {
        const next = this.index.get(this.order[end]).length;
        if (bytes && bytes + next > maxBytes) break;
        end++; bytes += next;
      }
    }
    return this.read(start, end - start);
  }
  async close() {
    if (this.closed) return;
    try { await this.flush(); await this.handle.sync(); }
    finally {
      this.closed = true; clearTimeout(this.timer); clearTimeout(this.streamTimer); await this.handle.close();
      try { const lock = JSON.parse(await readFile(this.lockPath, 'utf8')); if (lock.token === this.lockToken) await unlink(this.lockPath); } catch { /* Do not remove another writer's lock. */ }
    }
  }
  async exportTo(file) {
    await this.flush();
    await file.write('# ZC visible transcript\n\n');
    for (let start = 0; start < this.order.length; start += 100) {
      for (const entry of await this.read(start, 100)) {
        const title = entry.role === 'tool' ? `Tool: ${entry.name} (${entry.status})` : entry.role === 'user' ? 'You' : entry.role === 'assistant' ? 'ZC' : entry.role;
        await file.write(`## ${redact(title)}\n\n${redact(entry.role === 'tool' ? entry.output || '' : entry.text || '')}\n\n`);
      }
    }
  }
}
