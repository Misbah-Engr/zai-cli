import { randomUUID, createHash } from 'node:crypto';
import { mkdir, open, rename, unlink, readFile, lstat } from 'node:fs/promises';
import { dirname } from 'node:path';

export const VERSION = '0.2.0';
export const id = () => randomUUID();
export const hash = value => createHash('sha256').update(value).digest('hex');
export const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const messageOf = error => error instanceof Error ? error.message : String(error);
export const abortError = () => Object.assign(new Error('Stopped by you.'), { name: 'AbortError' });
export function throwIfAborted(signal) { if (signal?.aborted) throw abortError(); }

// Sanitize untrusted terminal content, including OSC 52 clipboard payloads.
export function clean(value) {
  return String(value ?? '')
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[P^_][\s\S]*?\x1b\\/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[ -/]*[0-~]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\t/g, '    ');
}
export function redact(value) {
  let result = clean(value);
  for (const key of ['ZAI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN']) {
    const secret = process.env[key];
    if (secret && secret.length >= 6) result = result.split(secret).join('[REDACTED]');
  }
  return result.replace(/(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]');
}
export function bounded(value, limit = 16000) {
  const s = clean(value);
  return s.length <= limit ? s : `${s.slice(0, limit)}\n[Output limited to ${limit} characters.]`;
}
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export const graphemes = text => Array.from(segmenter.segment(text), part => part.segment);
export function cellWidth(char) {
  if (/^[\p{Mark}\u200d\ufe0f]+$/u.test(char)) return 0;
  if (/\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(char)) return 2;
  const p = char.codePointAt(0);
  if (p >= 0x1100 && (p <= 0x115f || p === 0x2329 || p === 0x232a ||
    (p >= 0x2e80 && p <= 0xa4cf && p !== 0x303f) || (p >= 0xac00 && p <= 0xd7a3) ||
    (p >= 0xf900 && p <= 0xfaff) || (p >= 0xfe10 && p <= 0xfe19) ||
    (p >= 0xfe30 && p <= 0xfe6f) || (p >= 0xff00 && p <= 0xff60) ||
    (p >= 0xffe0 && p <= 0xffe6) || (p >= 0x20000 && p <= 0x3fffd))) return 2;
  return 1;
}
export const width = text => graphemes(clean(text)).reduce((sum, char) => sum + cellWidth(char), 0);
export function takeCells(text, cells) {
  let out = '', size = 0;
  for (const char of graphemes(clean(text))) {
    const n = cellWidth(char);
    if (size + n > Math.max(0, cells)) break;
    out += char; size += n;
  }
  return out;
}
export function truncate(text, cells, suffix = '…') {
  const value = clean(text).replace(/\n/g, ' ');
  return width(value) <= cells ? value : takeCells(value, cells - width(suffix)) + (cells > 0 ? suffix : '');
}
export function wrap(text, columns) {
  const size = Math.max(1, columns), rows = [];
  for (const line of clean(text).split('\n')) {
    let row = '', count = 0;
    for (const char of graphemes(line)) {
      const w = cellWidth(char);
      if (count + w > size) { rows.push(row); row = ''; count = 0; }
      if (w <= size) { row += char; count += w; }
    }
    rows.push(row);
  }
  return rows;
}
/** Prose wraps on word boundaries; long identifiers still wrap at cell boundaries. */
export function wrapWords(text, columns) {
  const size = Math.max(1, columns), rows = [];
  for (const line of clean(text).split('\n')) {
    let row = '', cells = 0, gap = '';
    for (const token of line.match(/\S+|\s+/gu) || []) {
      if (/^\s+$/u.test(token)) { gap = token; continue; }
      const count = width(token), spacing = row ? gap : '';
      if (row && cells + width(spacing) + count > size) { rows.push(row); row = ''; cells = 0; }
      if (row) { row += spacing; cells += width(spacing); }
      for (const char of graphemes(token)) {
        const w = cellWidth(char);
        if (cells + w > size) { if (row) rows.push(row); row = ''; cells = 0; }
        if (w <= size) { row += char; cells += w; }
      }
      gap = '';
    }
    rows.push(row);
  }
  return rows;
}
export function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const finish = () => { signal?.removeEventListener('abort', stop); resolve(); };
    const timer = setTimeout(finish, ms);
    const stop = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); reject(abortError()); };
    signal?.addEventListener('abort', stop, { once: true });
  });
}
export async function atomicWrite(path, data, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try { if ((await lstat(path)).isSymbolicLink()) throw new Error(`Refusing symbolic link: ${path}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = `${path}.${id()}.tmp`;
  let file;
  try {
    file = await open(temporary, 'wx', mode);
    await file.writeFile(data, 'utf8');
    await file.sync(); await file.close(); file = undefined;
    await rename(temporary, path);
  } finally {
    await file?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}
export const writeJson = (path, data) => atomicWrite(path, JSON.stringify(data, null, 2) + '\n');
export async function readJson(path, fallback, max = 8 * 1024 * 1024) {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Expected a regular file: ${path}`);
    if (stat.size > max) throw new Error(`File exceeds ${max} bytes: ${path}`);
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    if (error instanceof SyntaxError) throw new Error(`Invalid JSON in ${path}. Your file was not overwritten.`);
    throw error;
  }
}
