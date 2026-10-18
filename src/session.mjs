import {mkdir, open, writeFile, rename, readdir, lstat, unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join, resolve} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
export const stateDir = () => resolve(process.env.ZAI_HOME || join(homedir(), '.zai-workbench'));
const validID = id => { if (typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw new Error('Invalid session ID. Use zai sessions.'); return id; };
export function newSession(cwd) { return {version: 1, id: randomUUID(), cwd: resolve(cwd), updated: new Date().toISOString(), messages: []}; }
// Session files are untrusted input. Never replay a forged system message or an
// incomplete tool sequence into the provider's instruction context.
export function validateSession(session, {id = session?.id, cwd = session?.cwd} = {}) {
  const invalid = () => { throw new Error('Invalid or corrupted session message history.'); };
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!object(session) || session.version !== 1 || session.id !== id || typeof session.cwd !== 'string' || session.cwd !== resolve(cwd) || !Array.isArray(session.messages)) {
    throw new Error('Session does not match this workspace or has an unsupported format.');
  }
  validID(session.id);
  if (typeof session.updated !== 'string' || !Number.isFinite(Date.parse(session.updated)) || session.messages.length > 10000) invalid();
  const pending = new Set(), used = new Set();
  for (const message of session.messages) {
    if (!object(message)) invalid();
    if (pending.size && message.role !== 'tool') invalid();
    if (message.role === 'user') {
      if (typeof message.content !== 'string' || Object.keys(message).some(key => !['role', 'content'].includes(key))) invalid();
    } else if (message.role === 'assistant') {
      if (message.content !== null && typeof message.content !== 'string') invalid();
      if (message.reasoning_content !== undefined && typeof message.reasoning_content !== 'string') invalid();
      if (Object.keys(message).some(key => !['role', 'content', 'reasoning_content', 'tool_calls'].includes(key))) invalid();
      if (message.tool_calls !== undefined) {
        if (!Array.isArray(message.tool_calls) || !message.tool_calls.length || message.tool_calls.length > 32) invalid();
        for (const call of message.tool_calls) {
          if (!object(call) || typeof call.id !== 'string' || !call.id || call.id.length > 256 || used.has(call.id) || call.type !== 'function' || !object(call.function)) invalid();
          if (typeof call.function.name !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(call.function.name) || typeof call.function.arguments !== 'string') invalid();
          if (Object.keys(call).some(key => !['id', 'type', 'function'].includes(key)) || Object.keys(call.function).some(key => !['name', 'arguments'].includes(key))) invalid();
          pending.add(call.id); used.add(call.id);
        }
      }
    } else if (message.role === 'tool') {
      if (typeof message.content !== 'string' || !pending.delete(message.tool_call_id) || Object.keys(message).some(key => !['role', 'content', 'tool_call_id'].includes(key))) invalid();
    } else invalid();
  }
  if (pending.size) invalid();
  return session;
}
async function directory() {
  const dir = stateDir();
  await mkdir(dir, {recursive: true, mode: 0o700});
  if ((await lstat(dir)).isSymbolicLink()) throw new Error('Session directory cannot be a symbolic link.');
  return dir;
}
export async function saveSession(session) {
  validateSession(session);
  const dir = await directory();
  session.updated = new Date().toISOString();
  const path = join(dir, `${validID(session.id)}.json`), temp = `${path}.${randomUUID()}.tmp`;
  const serialized = JSON.stringify(session, null, 2);
  if (Buffer.byteLength(serialized) > 8 * 1024 * 1024) throw new Error('Session exceeds the 8 MiB storage limit.');
  try {
    await writeFile(temp, serialized, {mode: 0o600, flag: 'wx'});
    await rename(temp, path);
  } finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
async function readRecord(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) throw new Error('Invalid or oversized session file.');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.size > 8 * 1024 * 1024) throw new Error('Invalid or oversized session file.');
    const buffer = Buffer.alloc(current.size + 1);
    let count = 0;
    while (count < buffer.length) {
      const {bytesRead} = await handle.read(buffer, count, buffer.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    if (count > current.size) throw new Error('Session file changed while reading.');
    return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(buffer.subarray(0, count)));
  } finally { await handle.close(); }
}
export async function loadSession(id, cwd) {
  const path = join(await directory(), `${validID(id)}.json`);
  return validateSession(await readRecord(path), {id, cwd});
}
export async function listSessions() {
  const dir = await directory(), result = [];
  for (const name of await readdir(dir)) {
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
    const path = join(dir, name);
    try { const s = validateSession(await readRecord(path), {id: name.slice(0, -5)}); result.push({id: s.id, cwd: s.cwd, updated: s.updated}); } catch { /* Ignore damaged records. */ }
  }
  return result.sort((a,b) => String(b.updated).localeCompare(String(a.updated)));
}
