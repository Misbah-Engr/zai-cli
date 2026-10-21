import { homedir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { readJson, writeJson, isRecord } from './util.mjs';

export const DEFAULTS = Object.freeze({
  backend: 'native', theme: 'auto', mode: 'ask',
  model: 'glm-5.3', streamModel: '', endpoint: 'https://api.z.ai/api/coding/paas/v4',
  runtime: { command: 'managed', args: [] },
  maxSteps: 30, contextBudget: 240000, requestTimeoutMs: 180000,
});
export function stateDir(env = process.env) {
  if (env.ZC_HOME) return resolve(env.ZC_HOME);
  if (process.platform === 'win32') return join(env.LOCALAPPDATA || homedir(), 'StrikingLions', 'zc');
  return join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'zc');
}
export function validateConfig(value) {
  if (!isRecord(value)) throw new Error('Configuration must be a JSON object.');
  const allowed = Object.keys(DEFAULTS);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown configuration field: ${key}`);
  const out = { ...DEFAULTS, ...value, runtime: { ...DEFAULTS.runtime, ...value.runtime } };
  if (!['native', 'native-stream', 'zai'].includes(out.backend)) throw new Error('backend must be native, native-stream, or zai.');
  if (!['auto', 'dark', 'light', 'mono'].includes(out.theme)) throw new Error('theme must be auto, dark, light, or mono.');
  if (!['ask', 'read-only', 'guarded'].includes(out.mode)) throw new Error('mode must be ask, read-only, or guarded (native-stream only).');
  if (typeof out.model !== 'string' || !/^[A-Za-z0-9._:/-]{1,128}$/.test(out.model)) throw new Error('Invalid model identifier.');
  if (typeof out.streamModel !== 'string' || out.streamModel.length > 512 || (out.streamModel && !/^[A-Za-z0-9._:-]+\/[A-Za-z0-9._:/-]+$/.test(out.streamModel))) throw new Error('streamModel must be an exact providerId/modelId without a reasoning suffix.');
  let url;
  try { url = new URL(out.endpoint); } catch { throw new Error('Invalid endpoint URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('The API endpoint must use HTTPS without credentials, query, or fragment.');
  out.endpoint = out.endpoint.replace(/\/+$/, '');
  if (value.runtime !== undefined && !isRecord(value.runtime)) throw new Error('runtime must contain a command and an args array.');
  for (const key of Object.keys(out.runtime)) if (!['command', 'args'].includes(key)) throw new Error(`Unknown runtime field: ${key}`);
  if (typeof out.runtime.command !== 'string' || !out.runtime.command.trim() || /[\0\r\n]/.test(out.runtime.command)) throw new Error('Invalid runtime command.');
  if (!Array.isArray(out.runtime.args) || out.runtime.args.some(x => typeof x !== 'string' || x.includes('\0'))) throw new Error('runtime.args must be an array of argument strings.');
  for (const [key, min, max] of [['maxSteps', 1, 100], ['contextBudget', 8000, 1000000], ['requestTimeoutMs', 1000, 900000]]) {
    if (!Number.isInteger(out[key]) || out[key] < min || out[key] > max) throw new Error(`${key} must be an integer between ${min} and ${max}.`);
  }
  return out;
}
export async function loadConfig(overrides = {}) {
  const path = join(stateDir(), 'config.json');
  const value = await readJson(path, {});
  return validateConfig({ ...value, ...Object.fromEntries(Object.entries(overrides).filter(([,v]) => v !== undefined)) });
}
export async function saveConfig(config) {
  await writeJson(join(stateDir(), 'config.json'), validateConfig(config));
}
export function parseRuntimeCommand(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Supply a runtime executable or an absolute .cjs/.mjs path.');
  if (/\.(?:[cm]?js)$/i.test(value)) {
    if (!isAbsolute(value)) throw new Error('Use an absolute path for a runtime JavaScript bundle.');
    return { command: process.execPath, args: [value] };
  }
  return { command: value, args: [] };
}
