import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { realpath, lstat, open } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, saveConfig, validateConfig, parseRuntimeCommand, stateDir } from './config.mjs';
import { VERSION, redact, clean, readJson, hash } from './util.mjs';
import { executableExists, spawnProcess } from './process.mjs';
import { TerminalApp, createBackend, trustWorkspace } from './ui/app.mjs';
import { probeStreamRuntime } from './backends/native-stream.mjs';
import { streamModel } from './backends/stream-contract.mjs';
import { WorkspaceState } from './state.mjs';
import { resolveRuntime, runtimeEnvironment, supportsRuntimeNode, RUNTIME_VERSION } from './runtime.mjs';

export const HELP = `ZC ${VERSION} | Striking Lions

  zc                         Open this project
  zc /path/to/project        Open another project
  zc resume                  Resume this workspace's last saved conversation
  zc login                   Sign in to your Z.ai account
  zc doctor                  Check installation without a model request
  zc demo                    Try the interface offline
  zc setup                   Configure connection and theme
  zc exec "task" --trust      One noninteractive task; requested approvals are denied
  zc audit                   Launch with read-only tools
  zc init                    Create AGENTS.md without overwriting

Options
  --cwd <directory>          Project directory
  --resume <id>              Resume an exact saved session
  --model <provider/model>   Select a runtime-advertised model
  --theme auto|light|dark|mono
  --plain                    Line interface for screen readers/simple terminals
  --json                     NDJSON for exec, JSON for doctor
  --trust                    Trust this workspace and provider for this invocation
  --mode ask|read-only       Launch policy; full access requires /mode yolo confirmation
  --backend native|native-stream|zai
                            Advanced connection override; native is the default
  --oauth --no-browser       Login-only options
  --version, -v              Show version
  --help, -h                 Show this help

Inside ZC: /model, /mode yolo, /sessions, /status, /reconnect, /login, /search, /export.
Click to position the caret. Drag or Shift+arrows selects text. Ctrl+A selects the draft.
Ctrl+R opens prompt history. Mouse wheel and PgUp/PgDn scroll the conversation.
Ctrl+Home/Ctrl+End jumps to oldest/latest work. Ctrl+C copies a selection.
Esc stops an active turn. Ctrl+C twice quits. No OS sandbox is supplied.

ZC installs its pinned runtime dependency. No separate zcode installation is required.
An account with model access is still required. See zc help auth.
`;
const AUTH = `Account login:
  zc login
  zc

On an SSH server:
  zc login --oauth --no-browser
Open the displayed authorization link privately on your own device.
The runtime owns credentials. ZC does not import or copy token files.
Use /login inside ZC to sign in and return to the same workspace.

Direct API is an optional, explicit alternative:
  zc config backend zai
Set ZAI_API_KEY securely in your shell. It is not stored by ZC.
There is no silent fallback to API billing.

Advanced external runtime override:
  zc config runtime /absolute/path/to/zcode
Return to the managed dependency:
  zc config runtime managed
`;
export function argumentsFor(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
    backend: { type: 'string' }, cwd: { type: 'string' }, mode: { type: 'string' }, model: { type: 'string' },
    oauth: { type: 'boolean' }, 'no-browser': { type: 'boolean' },
    resume: { type: 'string' }, theme: { type: 'string' }, plain: { type: 'boolean' }, json: { type: 'boolean' }, trust: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
  } });
  return { values, positionals };
}
async function setup(config, values) {
  if (!process.stdin.isTTY) {
    if (!values.backend) throw new Error('Noninteractive setup requires --backend native or --backend zai.');
    await saveConfig(config); console.log('Configuration saved.'); return;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('ZC setup\n1  Z.ai account, managed runtime\n2  Direct API, explicit API-key billing\n');
    const answer = (await rl.question('Connection [1]: ')).trim() || '1';
    if (!['1', '2'].includes(answer)) throw new Error('Choose 1 or 2. Nothing was changed.');
    config.backend = answer === '1' ? 'native' : 'zai'; config.mode = 'ask';
    if (answer === '1') config.runtime = { command: 'managed', args: [] };
    config.theme = (await rl.question('Theme [auto/light/dark/mono, default auto]: ')).trim() || 'auto';
    await saveConfig(config);
    console.log(answer === '1' ? 'Saved. Run zc login once, then zc in your project.' : 'Saved. Set ZAI_API_KEY securely, then run zc.');
  } finally { rl.close(); }
}
async function doctor(config, cwd, json) {
  const checks = [
    { name: 'node', ok: supportsRuntimeNode(), detail: process.versions.node + ' (native runtime requires 24.14+)' },
    { name: 'workspace', ok: (await lstat(cwd)).isDirectory(), detail: cwd },
    { name: 'git', ok: await executableExists('git'), detail: 'Optional for Git views' },
    { name: 'backend', ok: true, detail: config.backend },
  ];
  if (config.backend === 'zai') checks.push({ name: 'api_key', ok: Boolean(process.env.ZAI_API_KEY), detail: 'Environment presence only; no request was made' });
  else {
    try {
      const runtime = resolveRuntime(config.runtime);
      checks.push({ name: 'runtime', ok: await executableExists(runtime.command), detail: runtime.managed ? `Managed zcode-app-cli ${runtime.version}` : runtime.command });
      if (config.backend === 'native-stream') { const identity = await probeStreamRuntime(runtime, cwd); checks.push({ name: 'stream_pair', ok: true, detail: identity.client + ' / ' + identity.runtime }); }

    } catch (error) { checks.push({ name: 'runtime', ok: false, detail: error.message }); }
  }
  if (config.backend !== 'zai') checks.push({ name: 'authentication', ok: null, detail: 'Not tested. Delegated to the runtime; doctor does not verify login or model access.' });
  if (json) console.log(JSON.stringify({ version: VERSION, checks }, null, 2));
  else { console.log(`ZC ${VERSION} | Local diagnostics\n`); for (const c of checks) console.log(`${c.ok === null ? 'INFO' : c.ok ? 'OK  ' : 'WARN'} ${c.name.padEnd(16)} ${redact(c.detail)}`); }
  return checks.some(c => c.ok === false && c.name !== 'git') ? 1 : 0;
}
async function login(config, values) {
  if (!process.stdin.isTTY) throw new Error('Account login requires an interactive terminal.');
  const runtime = resolveRuntime(config.runtime);
  return await new Promise((resolve, reject) => {
    const child = spawnProcess(runtime.command, [...runtime.args, 'login', ...(values.oauth ? ['--oauth'] : []), ...(values['no-browser'] || process.env.SSH_CONNECTION ? ['--no-browser'] : [])], { stdio: 'inherit', env: runtimeEnvironment(runtime) });
    child.once('error', reject); child.once('close', code => resolve(code ?? 130));
  });
}
async function plain({ config, cwd, demo, trust, prompt, resume, exec, json, model }) {
  const state = new WorkspaceState(), controller = new AbortController(); let backend;
  const rl = process.stdin.isTTY && !exec ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  const onSignal = () => controller.abort();
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  const emit = event => {
    state.apply(event);
    if (json) { process.stdout.write(JSON.stringify(JSON.parse(JSON.stringify(event), (_, value) => typeof value === 'string' ? redact(value) : value)) + '\n'); return; }
    if (event.type === 'notice') process.stderr.write(redact(event.text) + '\n');
    if (event.type === 'tool') process.stderr.write(`[${event.status}] ${clean(event.name || 'tool')}\n`);
    if (!exec && event.type === 'delta') process.stdout.write(redact(event.text));
  };
  const ask = async (request, signal) => {
    if (!rl || signal?.aborted) { process.stderr.write(`Denied: ${redact(request.title)} (noninteractive mode).\n`); return false; }
    console.log(`\n${redact(request.title)}\n${redact(request.detail)}\n${redact(request.input)}\n`);
    try { return (await rl.question(request.allowLabel === 'Enable YOLO' ? 'Type yes to enable full access for this session [default no]: ' : 'Type yes to approve once [default no]: ', { signal })).trim().toLowerCase() === 'yes'; }
    catch { return false; }
  };
  try {
    if (!demo) await trustWorkspace({ cwd, config, trust, ask, signal: controller.signal });
    backend = createBackend({ cwd, config, emit, ask, demo });
    await backend.start(resume);
    if (model && config.backend === 'native') await backend.setModel(model);
    if (prompt) {
      const before = state.entries.length; await backend.send(prompt, controller.signal);
      if (!json) {
        if (exec) console.log(state.entries.slice(before).filter(e => e.role === 'assistant').map(e => redact(e.text)).join('\n'));
        else console.log();
      }
      if (exec || !rl) return 0;
    }
    if (!rl) throw new Error('Interactive input needs a TTY. Use zc exec "task" --trust, or zc demo --plain.');
    console.log(config.backend === 'native-stream' ? '\nPlain stream mode. /quit exits. No ZC tool approvals are available; execution follows guarded runtime policy.' : '\nPlain mode. /quit exits. Direct API approvals require explicit yes; native follows runtime policy.');
    while (!controller.signal.aborted) {
      const text = (await rl.question('\nzc > ', { signal: controller.signal })).trim();
      if (!text) continue; if (['/quit', '/exit'].includes(text)) break;
      if (text === '/model' && typeof backend.models === 'function') {
        const models = await backend.models();
        console.log(models.length ? models.map(m => `${m.value}  ${m.label}${m.disabled ? ' [unavailable: ' + m.disabledReason + ']' : ''}`).join('\n') : 'The runtime returned no model options.');
        continue;
      }
      if (text.startsWith('/model ') && typeof backend.setModel === 'function') {
        try { await backend.setModel(text.slice(7).trim()); console.log(config.backend === 'native-stream' ? 'Model selected locally. ZCode validates it on the next prompt.' : 'Model selection updated.'); }
        catch (error) { console.error(redact(error.message)); }
        continue;
      }
      if ((text === '/mode' || text.startsWith('/mode ')) && config.backend === 'native' && !demo) {
        const value = text.slice(5).trim();
        try {
          if (value) {
            const result = await backend.setMode(value, controller.signal);
            console.log(result.declined ? 'Full access was not enabled.' : `Mode: ${backend.mode} (runtime: ${backend.runtimeMode}).`);
          } else console.log(`Mode: ${backend.mode}. /mode yolo enables full access; /mode ask returns guarded runtime policy.`);
        } catch (error) { console.error(redact(error.message)); }
        continue;
      }
      if (text.startsWith('/')) { console.log('Plain mode supports /quit, native /model, and native /mode ask|yolo. Use launch flags for other settings.'); continue; }
      await backend.send(text, controller.signal); console.log();
    }
    return 0;
  } finally { rl?.close(); process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal); await backend?.dispose(); }
}
export async function main(argv = process.argv.slice(2)) {
  process.stdout.on('error', error => { if (error.code === 'EPIPE') process.exitCode = 0; });
  try {
    const { values, positionals } = argumentsFor(argv);
    if (values.version) { console.log(VERSION); return; }
    if (values.help || positionals[0] === 'help') { console.log(positionals[1] === 'auth' ? AUTH : HELP); return; }
    let command = positionals[0];
    const known = ['resume', 'stream', 'demo', 'setup', 'doctor', 'login', 'audit', 'exec', 'config', 'init'];
    if (command && !known.includes(command)) {
      const candidate = resolve(command);
      if (positionals.length === 1 && await lstat(candidate).then(s => s.isDirectory(), () => false)) { values.cwd = candidate; command = undefined; }
      else throw new Error(`Unknown command: ${command}. Use zc --help, or zc /path/to/project.`);
    }
    if (values.json && command !== 'exec' && command !== 'doctor') throw new Error('--json is supported by exec and doctor.');
    if ((values.oauth || values['no-browser']) && command !== 'login') throw new Error('--oauth and --no-browser are login-only flags.');
    if (command === 'stream' && values.backend && values.backend !== 'native-stream') throw new Error('zc stream cannot select a different backend.');
    const config = await loadConfig({ backend: command === 'stream' ? 'native-stream' : values.backend, mode: command === 'audit' ? 'read-only' : command === 'stream' ? values.mode || 'guarded' : values.mode, theme: values.theme });
    if (values.model) {
      if (config.backend === 'native-stream') config.streamModel = streamModel(values.model);
      else if (config.backend === 'zai') config.model = values.model;
    }
    Object.assign(config, validateConfig(config));

    const cwd = await realpath(resolve(values.cwd || process.cwd()));
    if (!(await lstat(cwd)).isDirectory()) throw new Error('--cwd must identify a directory.');
    let resumePicker = false;
    if (command === 'resume' && !values.resume) {
      const saved = await readJson(join(stateDir(), 'workspaces', hash(cwd).slice(0, 24) + '.json'), {});
      if (!saved.sessionId) {
        if (!process.stdin.isTTY || values.plain) throw new Error('No last session is recorded for this project. Run zc interactively, then /sessions.');
        resumePicker = true;
      } else values.resume = saved.sessionId;
      if (saved.backend && !values.backend) config.backend = saved.backend;
    }
    if (command === 'config') {
      const [, key, ...rest] = positionals, value = rest.join(' ');
      if (!key) console.log(JSON.stringify(config, null, 2));
      else if (key === 'managed' && !value) {
        await saveConfig({ ...config, backend: 'native', mode: 'ask', runtime: { command: 'managed', args: [] } });
        console.log('Managed runtime enabled. Existing theme, credentials, and session data are preserved.');
      }
      else if (['runtime', 'backend', 'model', 'streamModel', 'endpoint', 'theme', 'mode'].includes(key) && value) { config[key] = key === 'runtime' ? parseRuntimeCommand(value) : value; await saveConfig(config); console.log(`Saved ${key}.`); }
      else throw new Error('Use zc config runtime|backend|model|streamModel|endpoint|theme|mode <value>. API keys are environment-only.');
      return;
    }
    if (command === 'setup') { await setup(config, values); return; }
    if (command === 'doctor') { process.exitCode = await doctor(config, cwd, values.json); return; }
    if (command === 'login') { process.exitCode = await login(config, values); return; }
    if (command === 'init') {
      const file = await open(join(cwd, 'AGENTS.md'), 'wx', 0o644);
      try { await file.writeFile('# Project guidance\n\nDescribe the architecture, test commands, and conventions here.\n\nRead relevant source before proposing changes. Keep diffs focused.\nReport tests actually run, and label unverified assumptions.\nNever commit credentials or generated session transcripts.\n', 'utf8'); } finally { await file.close(); }
      console.log('Created AGENTS.md. Existing files were not overwritten.'); return;
    }
    const demo = command === 'demo';
    if (!demo && config.backend !== 'zai') {
      const runtime = resolveRuntime(config.runtime);
      if (runtime.managed && !supportsRuntimeNode()) throw new Error('The managed runtime needs Node.js 24.14+. Use the supplied installer, which installs an isolated Node runtime and a plain zc launcher.');
    }
    if (!demo && config.backend !== 'native-stream' && config.mode === 'guarded') throw new Error('guarded is reserved for native-stream. Choose ask or read-only for this backend.');
    let prompt = positionals.slice(1).join(' ');
    if (command === 'audit' && !prompt) prompt = 'Inspect this repository for security issues. Start by mapping its trust boundaries and important invariants. Do not edit files or run shell commands. Separate confirmed findings from hypotheses, and cite source paths and lines. Do not invent tests or findings.';
    if (command === 'exec' && !prompt.trim()) throw new Error('Provide a task: zc exec "Explain this repository" --trust');
    if (demo && (values.plain || !process.stdout.isTTY)) prompt ||= 'Show me the workspace.';
    if (command === 'exec' || values.plain || !process.stdout.isTTY || !process.stdin.isTTY) {
      process.exitCode = await plain({ config, cwd, demo, trust: values.trust, prompt, resume: values.resume, exec: command === 'exec', json: values.json, model: values.model });
    } else {
      const app = new TerminalApp({ config, cwd, demo, trust: values.trust, resume: values.resume, resumePicker, prompt, model: values.model });
      process.exitCode = await app.run();
    }
  } catch (error) {
    console.error(`ZC: ${redact(error.message)}${error.code === 'ENOENT' ? '\nRun zc doctor to check your runtime and paths.' : ''}`);
    process.exitCode = error.name === 'AbortError' ? 130 : 1;
  }
}
