import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute } from 'node:path';

export const RUNTIME_VERSION = '3.15.3-37';
const require = createRequire(import.meta.url);
/** Resolve only the published public bin. Never import private runtime internals. */
export function resolveRuntime(runtime, { resolvePackage = spec => require.resolve(spec), node = process.execPath } = {}) {
  if (!['managed', 'bundled'].includes(runtime.command)) return { ...runtime, managed: false };
  let manifestPath;
  try { manifestPath = resolvePackage('zcode-app-cli/package.json'); }
  catch { throw new Error('ZC runtime dependency is missing. Reinstall the complete ZC package with its dependencies. Existing credentials and sessions do not need deletion.'); }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.name !== 'zcode-app-cli' || manifest.version !== RUNTIME_VERSION) throw new Error(`Runtime version mismatch. This ZC release requires ${RUNTIME_VERSION}. Reinstall ZC rather than changing credentials.`);
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.zcode;
  if (typeof bin !== 'string' || isAbsolute(bin)) throw new Error('Runtime package has an invalid public entry point.');
  const root = dirname(manifestPath), entry = resolve(root, bin), rel = relative(root, entry);
  if (rel.startsWith('..') || !existsSync(entry)) throw new Error('Runtime package entry point is missing or outside its package.');
  return { command: node, args: [entry, ...(runtime.args || [])], managed: true, version: manifest.version };
}
export function runtimeEnvironment(runtime, env = process.env) {
  return { ...env, ...(runtime.managed ? { ZCODE_NODE: runtime.command } : {}), ZCODE_APP_SERVER_AUTH_MODE: env.ZCODE_APP_SERVER_AUTH_MODE || 'standalone' };
}
export function supportsRuntimeNode(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  return major > 24 || (major === 24 && minor >= 14);
}
