import {createInterface} from 'node:readline/promises';
import {realpath, access, stat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {isAbsolute} from 'node:path';
import {RuntimeBridge} from './runtime-bridge.mjs';
import {clean} from './display.mjs';
import {RuntimeDiagnostics, redactRuntimeDiagnostic} from './runtime-diagnostics.mjs';

export function requireRuntimeNode(version = process.versions.node) {
  const [major, minor, patch] = version.split('.').map(Number);
  if (!Number.isInteger(major) || major < 22 || (major === 22 && minor < 19) || !Number.isInteger(patch)) {
    throw new Error(`Z.ai Workbench runtime mode requires Node.js 22.19.0 or newer; this process is using Node.js ${version}. Install Node.js 24 LTS, reopen your terminal, and check node --version before retrying. ZCODE_NODE does not upgrade the Node.js process running Workbench.`);
  }
}

export async function runRuntimeCLI(v, command, {Bridge = RuntimeBridge} = {}) {
  requireRuntimeNode();
  for (const flag of ['profile', 'reasoning', 'allow-read', 'max-tools', 'no-save']) {
    if (v[flag] !== undefined) throw new Error(`--${flag} is supported only with --backend api. Runtime settings and storage are managed by ZCode.`);
  }
  const cwd = await realpath(v.cwd || process.cwd());
  let executable = 'zcode';
  if (v['runtime-path']) {
    if (!isAbsolute(v['runtime-path'])) throw new Error('--runtime-path must be an absolute path to a trusted zcode executable.');
    executable = await realpath(v['runtime-path']);
    if (!(await stat(executable)).isFile()) throw new Error('--runtime-path must name a file.');
    await access(executable, process.platform === 'win32' || /\.(?:c?js|mjs)$/i.test(executable) ? constants.R_OK : constants.X_OK);
  }
  const note = text => process.stderr.write(clean(text) + '\n');
  if (command === 'doctor') {
    note(`Node ${process.version}\nBackend: runtime\nWorkspace: ${cwd}\nRuntime: ${executable}\nLogin: managed by zcode-app-cli; not inspected\nRun zcode and complete its login before using Workbench.\nExecutable discovery, runtime connection and network: not tested. No API requests made.`);
    return;
  }
  if (command === 'sessions') throw new Error('For direct-API sessions use zai --backend api sessions. Manage runtime sessions in zcode; resume a known native ID with --resume.');
  const interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY);
  if (!interactive && !v.prompt) throw new Error('Noninteractive use requires --prompt. Runtime approval requests will be denied.');
  let model;
  if (v.model) {
    const slash = v.model.indexOf('/');
    if (slash < 1 || slash === v.model.length - 1) throw new Error('Runtime --model requires PROVIDER/MODEL from your ZCode configuration. Omit it to use the runtime default.');
    model = {providerId: v.model.slice(0, slash), modelId: v.model.slice(slash + 1)};
  }
  const rl = interactive ? createInterface({input: process.stdin, output: process.stderr, terminal: true}) : null;
  let closed = false, controller, bridge, snapshot, activity;
  let diagnostics;
  const animated = interactive && !v.plain && !process.env.NO_COLOR;
  const ask = async text => {
    if (!rl || closed || controller?.signal.aborted) return '';
    try { return await rl.question(text, controller ? {signal: controller.signal} : {}); } catch { return ''; }
  };
  const interrupt = () => { if (controller) controller.abort(); else rl?.close(); };
  rl?.on('close', () => { closed = true; controller?.abort(); });
  rl?.on('SIGINT', interrupt);
  process.on('SIGINT', interrupt);
  try {
    const createBridge = () => {
    diagnostics = new RuntimeDiagnostics({onLine: v['debug-runtime'] ? line => {activity?.stop(); note(`Runtime diagnostic: ${line}`);} : undefined});
    const next = new Bridge({command: executable, cwd,
      onPermission: async request => {
        if (!interactive || closed || controller?.signal.aborted) return {decision: 'deny', reason: 'No interactive approval available'};
        activity?.stop();
        note(`\nRuntime approval request:\n${JSON.stringify(request, null, 2)}`);
        try {
          return (await ask('Allow this request once? [y/N] ')).trim().toLowerCase() === 'y'
            ? {decision: 'allow'} : {decision: 'deny', reason: 'User declined'};
        } finally {activity?.start();}
      },
      // Structured forms and tool-specific questions are not guessed or auto-accepted.
      onUserInput: async () => {activity?.stop(); note('The runtime requested structured input this terminal does not support. Request cancelled. Continue in zcode if needed.'); return {action: 'cancel'};}
    });
    next.on('text', delta => {activity?.stop(); process.stdout.write(clean(delta));});
    next.on('reasoning', () => activity?.reasoning());
    next.on('tool', tool => {activity?.stop(); note(`\n  > ${tool.toolName || tool.name || 'runtime tool'}`); activity?.start();});
    next.on('diagnostic', chunk => diagnostics.write(chunk));
    return next;
    };
    bridge = createBridge();
    note('\n  Z.ai Workbench / 0.2.1 | runtime\n' + `  ${cwd}\n\nUsing the installed ZCode runtime and its existing login.\nThe runtime controls sandbox, tools, permissions, and saved sessions.\nIts guarded mode may allow actions without a prompt under its own rules.\nNo direct-API fallback.\n`);
    snapshot = await bridge.startSession({...(model ? {model} : {}), ...(v.resume ? {resumeSessionId: v.resume} : {}), mode: 'guarded'});
    const sessionID = () => snapshot?.session?.sessionId || snapshot?.sessionId || 'managed by runtime';
    note(`Runtime session: ${sessionID()}`);
    async function turn(text) {
      controller = new AbortController();
      const start = Date.now();
      let timer, showing = false, reasoningNoted = false, label = 'Working';
      const draw = () => process.stderr.write(`\r  ${label} ${((Date.now() - start) / 1000).toFixed(0)}s...`);
      activity = {
        start() {
          if (showing || controller?.signal.aborted) return;
          showing = true;
          if (animated) {draw(); timer = setInterval(draw, 400);}
        },
        stop() {
          if (timer) clearInterval(timer);
          timer = undefined;
          if (showing && animated) process.stderr.write('\r\x1b[2K');
          showing = false;
        },
        reasoning() {
          label = 'Thinking';
          if (!reasoningNoted && !animated) {note('  Thinking...'); reasoningNoted = true;}
          this.start();
        }
      };
      if (!animated) note('  Working...');
      activity.start();
      try {
        await bridge.send(text, {signal: controller.signal});
        if (controller.signal.aborted) throw new Error('Turn cancelled');
        activity.stop();
        process.stdout.write('\n');
        note(`\n  ${((Date.now() - start) / 1000).toFixed(1)}s | session ${sessionID()}\n`);
      } catch (error) {
        activity.stop();
        note(`\n${controller.signal.aborted ? 'Cancelled. Completed actions are not rolled back.' : `Error: ${redactRuntimeDiagnostic(error.message)}`}`);
        if (v.prompt) process.exitCode = controller.signal.aborted ? 130 : 1;
      } finally {activity.stop(); activity = undefined; controller = undefined;}
    }
    if (v.prompt) {await turn(v.prompt); return;}
    note('Type /help for commands. End a line with \\ for multiline input.');
    while (!closed) {
      let input = (await ask('\nyou > ')).trim();
      while (input.endsWith('\\') && !closed) input = input.slice(0, -1) + '\n' + await ask('    > ');
      if (closed || input === '/exit') break;
      if (!input) continue;
      if (input === '/help') {note('/new starts a runtime session | /status shows settings | /exit quits'); continue;}
      if (input === '/status') {note(`Backend: runtime\nExecutable: ${executable}\nWorkspace: ${cwd}\nSession: ${sessionID()}\nModel: ${model ? `${model.providerId}/${model.modelId}` : 'runtime default'}\nPermissions and storage: runtime-managed`); continue;}
      if (input === '/new') {await bridge.close(); bridge = createBridge(); snapshot = await bridge.startSession({...(model ? {model} : {}), mode: 'guarded'}); note(`Fresh runtime session: ${sessionID()}`); continue;}
      if (input.startsWith('/')) {note('Unknown command. Try /help.'); continue;}
      await turn(input);
    }
  } catch (error) {
    diagnostics?.flush();
    const detail = diagnostics?.last();
    const hint = detail && /\blisten\b/i.test(detail) && /\b(?:EPERM|EACCES)\b/.test(detail)
      ? '\nThe runtime could not open its local listener. Check OS or sandbox permissions for the socket/address shown above.' : '';
    throw new Error(`${redactRuntimeDiagnostic(error.message)}${detail ? `\nRuntime diagnostic: ${detail}` : ''}${hint}`);
  } finally {
    activity?.stop();
    await bridge?.close();
    if (v['debug-runtime']) diagnostics?.flush();
    rl?.close();
    process.removeListener('SIGINT', interrupt);
  }
}
