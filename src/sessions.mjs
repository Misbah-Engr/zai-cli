import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { stateDir } from './config.mjs';
import { hash, readJson, writeJson, isRecord, id, redact } from './util.mjs';
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export class Sessions {
  constructor(cwd, home = stateDir()) { this.cwd = cwd; this.directory = join(home, 'sessions', hash(cwd).slice(0, 24)); }
  path(sessionId) {
    if (!ID.test(sessionId)) throw new Error('Invalid session ID. Use an exact ID from /sessions.');
    return join(this.directory, sessionId + '.json');
  }
  async save(session) {
    if (session.cwd !== this.cwd) throw new Error('Cannot save a session for a different workspace.');
    // Redact known environment credentials before persistence, never persist authentication config.
    const data = JSON.stringify(session, null, 2);
    if (Buffer.byteLength(data) > 8 * 1024 * 1024) throw new Error('Session is too large to save. Start a new session or compact it.');
    let safe = data;
    for (const key of ['ZAI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN']) {
      const secret = process.env[key];
      if (secret?.length >= 6) safe = safe.split(JSON.stringify(secret).slice(1, -1)).join('[REDACTED]');
    }
    await writeJson(this.path(session.id), JSON.parse(safe));
  }
  async load(sessionId) {
    const data = await readJson(this.path(sessionId), null);
    if (!isRecord(data) || data.version !== 1 || data.id !== sessionId || data.cwd !== this.cwd || !Array.isArray(data.messages)) throw new Error('Session not found or invalid for this workspace.');
    if (data.messages.some(m => !isRecord(m) || !['system', 'user', 'assistant', 'tool'].includes(m.role))) throw new Error('Session contains invalid message records.');
    return data;
  }
  async list() {
    let files;
    try { files = await readdir(this.directory); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    const sessions = [];
    for (const name of files.filter(n => ID.test(n.replace(/\.json$/, '')) && n.endsWith('.json')).slice(0, 500)) {
      try {
        const s = await this.load(name.slice(0, -5));
        sessions.push({ id: s.id, title: redact(s.title || 'Untitled'), updatedAt: s.updatedAt });
      } catch { /* One corrupt file does not hide other sessions. */ }
    }
    return sessions.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 50);
  }
  create(model) { return { version: 1, id: id(), cwd: this.cwd, model, title: '', updatedAt: Date.now(), messages: [], inFlight: false }; }
}
