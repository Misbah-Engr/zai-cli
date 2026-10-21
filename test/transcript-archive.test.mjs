import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, open, readFile, appendFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TranscriptJournal } from '../src/transcript.mjs';
import { WorkspaceState } from '../src/state.mjs';
async function fixture(t) { const root = await mkdtemp(join(tmpdir(), 'zc-journal-')); t.after(() => rm(root, { recursive: true, force: true })); const journal = await TranscriptJournal.open('/project', 'fixture-session', root); t.after(async () => { if (!journal.closed) await journal.close().catch(() => {}); }); return { root, journal }; }
test('all 2,000 messages survive the 400-entry presentation cap and a reopen', async t => {
  const { root, journal } = await fixture(t), state = new WorkspaceState(); state.onRecord = (e, transient) => journal.stage(e, transient);
  for (let i = 0; i < 2000; i++) state.apply({ type: 'message', id: 'm' + i, role: 'assistant', text: `Message ${i}: retained history` });
  assert.equal(state.entries.length, 400); await journal.flush(); assert.equal(journal.order.length, 2000);
  assert.equal((await journal.read(0, 1))[0].text, 'Message 0: retained history'); await journal.close();
  const second = await TranscriptJournal.open('/project', 'fixture-session', root);
  try { assert.equal(second.order.length, 2000); assert.equal((await second.read(1999, 1))[0].id, 'm1999'); } finally { await second.close(); }
});
test('stream checkpoints update one entry without creating duplicate transcript rows', async t => {
  const { journal } = await fixture(t);
  journal.stage({ id: 'a', role: 'assistant', text: 'first' }, true); await journal.flush();
  journal.stage({ id: 'a', role: 'assistant', text: 'first second' }, true); await journal.flush();
  journal.stage({ id: 'a', role: 'assistant', text: 'Final answer' }); await journal.flush();
  assert.equal(journal.order.length, 1); assert.equal((await journal.read())[0].text, 'Final answer');
});
test('export includes older offscreen work and redacts typical credentials', async t => {
  const { root, journal } = await fixture(t);
  for (let i = 0; i < 501; i++) journal.stage({ id: String(i), role: 'user', text: `Retained ${i}` });
  journal.stage({ id: 'secret', role: 'notice', text: 'Authorization: Bearer sensitive-secret-value' });
  const path = join(root, 'export.md'), file = await open(path, 'wx', 0o600);
  try { await journal.exportTo(file); } finally { await file.close(); }
  const text = await readFile(path, 'utf8'); assert.match(text, /Retained 0/); assert.match(text, /Retained 500/); assert.doesNotMatch(text, /sensitive-secret-value/);
});
test('another active writer is refused without altering its journal', async t => {
  const { root, journal } = await fixture(t); journal.stage({ id: 'a', role: 'user', text: 'mine' }); await journal.flush();
  const before = await readFile(journal.path, 'utf8'); await assert.rejects(TranscriptJournal.open('/project', 'fixture-session', root), /already open/);
  assert.equal(await readFile(journal.path, 'utf8'), before);
});
test('incomplete tail is preserved and reported instead of silently truncated', async t => {
  const { root, journal } = await fixture(t); await journal.close(); await appendFile(journal.path, '{"entry":');
  await assert.rejects(TranscriptJournal.open('/project', 'fixture-session', root), /incomplete/);
  assert.equal(await readFile(journal.path, 'utf8'), '{"entry":');
});
test('identical resume snapshot does not rewrite every archived record', async t => {
  const { root, journal } = await fixture(t), entry = { id: 'a', role: 'user', text: 'Same' }; journal.stage(entry); await journal.close();
  const before = (await stat(journal.path)).size, reopened = await TranscriptJournal.open('/project', 'fixture-session', root);
  try { reopened.stage(entry); await reopened.flush(); assert.equal((await stat(journal.path)).size, before); } finally { await reopened.close(); }
});
test('archive files are owner-only on POSIX', async t => {
  const { journal } = await fixture(t); const mode = (await stat(journal.path)).mode;
  if (process.platform !== 'win32') assert.equal(mode & 0o077, 0);
});
test('history windows use a byte budget and remain contiguous in both directions', async t => {
  const { journal } = await fixture(t);
  for (let i = 0; i < 100; i++) journal.stage({ id: String(i), role: 'assistant', text: 'x'.repeat(10000) });
  await journal.flush();
  const first = await journal.window(0, 'forward', 500, 50000); assert.equal(first.length, 4); assert.deepEqual(first.map(e => e.id), ['0', '1', '2', '3']);
  const next = await journal.window(3, 'forward', 500, 50000); assert.deepEqual(next.map(e => e.id), ['3', '4', '5', '6']);
  const back = await journal.window(7, 'backward', 500, 50000); assert.deepEqual(back.map(e => e.id), ['3', '4', '5', '6']);
});

test('stale-lock reclamation admits only one concurrent writer', async t => {
  const { root, journal } = await fixture(t); const lockPath = journal.path + '.lock'; await journal.close();
  // Spawn and reap a real subprocess so the stale PID is an observed dead process.
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  await writeFile(lockPath, JSON.stringify({ pid: child.pid, token: 'stale-test' }), { mode: 0o600 });
  const attempts = await Promise.allSettled(Array.from({ length: 6 }, () => TranscriptJournal.open('/project', 'fixture-session', root)));
  const winners = attempts.filter(result => result.status === 'fulfilled');
  try {
    assert.equal(winners.length, 1);
    assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).token, winners[0].value.lockToken);
  } finally { await Promise.all(winners.map(result => result.value.close())); }
});
