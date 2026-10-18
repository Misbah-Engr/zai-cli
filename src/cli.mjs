#!/usr/bin/env node
import {createInterface} from 'node:readline/promises';
import {realpath} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {runTurn} from './agent.mjs';
import {endpointURL} from './provider.mjs';
import {newSession, loadSession, saveSession, listSessions, stateDir} from './session.mjs';

import {clean} from './display.mjs';
import {runRuntimeCLI} from './runtime-cli.mjs';
const help = `Z.ai Workbench  0.2.0
A lightweight terminal for your existing ZCode runtime.

Usage
  zai                              Start a runtime-backed conversation
  zai -p "Explain this"            Run one prompt
  zai --resume SESSION_ID          Resume a native runtime session
  zai doctor                       Check local configuration
  zai --backend api -p "Explain"   Explicit direct-API mode

Common options
  -p, --prompt TEXT    Run a single prompt
  --backend NAME      runtime (default) or api; never falls back
  --cwd PATH          Workspace directory
  --resume ID         Resume a session in the selected backend
  --model NAME        Runtime: PROVIDER/MODEL; API: model ID
  --runtime-path PATH Absolute path to a trusted zcode executable
  --plain             Disable terminal styling
  -h, --help          Show help
  -v, --version       Show version

Direct API options (--backend api only)
  --profile NAME      coding (default) or general (separately metered)
  --reasoning LEVEL   low, high (default), or max
  --allow-read        Approve safe workspace reads and API transmission
  --max-tools N       Tool calls per turn, 1..100, default 20
  --no-save           Do not persist direct-API conversation
  sessions            List direct-API local sessions

Runtime setup: install zcode-app-cli from its official source, then run zcode
and finish its login. Workbench launches zcode app-server with that runtime's
existing login and configuration. No API key is needed by Workbench in this mode.
Runtime owns sandbox, permissions, context, and session storage. Unknown approval
requests fail closed. Noninteractive approval requests are denied.
API environment: ZAI_API_KEY, ZAI_PROFILE, ZAI_MODEL, ZAI_REASONING,
ZAI_BASE_URL, ZAI_HOME. Common: NO_COLOR.
Commands: /help, /new, /status, /exit. Ctrl+C cancels the active turn.
`;

async function main() {
  const {values: v, positionals} = parseArgs({allowPositionals: true, options: {
    backend:{type:'string'},'runtime-path':{type:'string'},help:{type:'boolean',short:'h'},version:{type:'boolean',short:'v'},prompt:{type:'string',short:'p'},cwd:{type:'string'},model:{type:'string'},reasoning:{type:'string'},profile:{type:'string'},resume:{type:'string'},'allow-read':{type:'boolean'},'max-tools':{type:'string'},'no-save':{type:'boolean'},plain:{type:'boolean'}
  }});
  if (v.help) { process.stdout.write(help); return; }
  if (v.version) { console.log('0.2.0'); return; }
  if (positionals.length > 1 || (positionals[0] && !['sessions','doctor'].includes(positionals[0]))) throw new Error('Unknown command. Use zai --help.');
  const backend = v.backend || 'runtime';
  if (!['runtime','api'].includes(backend)) throw new Error('--backend must be runtime or api.');
  if (backend === 'runtime') return runRuntimeCLI(v, positionals[0]);
  if (v['runtime-path']) throw new Error('--runtime-path is only supported by --backend runtime.');
  if (positionals[0] === 'sessions') {
    for (const s of await listSessions()) console.log(clean(`${s.id}  ${s.updated}  ${s.cwd}`));
    return;
  }
  const cwd = await realpath(v.cwd || process.cwd());
  const interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY);
  const color = interactive && !v.plain && !process.env.NO_COLOR;
  const accent = s => color ? `\x1b[36m${s}\x1b[0m` : s;
  const note = s => process.stderr.write(clean(s) + '\n');
  let profile = v.profile || process.env.ZAI_PROFILE || 'coding';
  if (positionals[0] === 'doctor') {
    note(`Node ${process.version}\nWorkspace: ${cwd}\nAPI key: ${process.env.ZAI_API_KEY ? 'set (not displayed)' : 'missing'}\nProfile: ${profile || 'not selected'}\nSessions: ${stateDir()}\nNetwork: not tested. No API requests made.`); return;
  }
  if (!process.env.ZAI_API_KEY) throw new Error('Set ZAI_API_KEY in your environment. Use zai --help for setup options.');
  if (!interactive && !v.prompt) throw new Error('Noninteractive use requires --prompt. Workspace writes and commands will be denied.');
  const rl = interactive ? createInterface({input: process.stdin, output: process.stderr, terminal: true}) : null;
  let controller, closed = false;
  rl?.on('close', () => {closed = true; controller?.abort();});
  const interrupt = () => { if (controller) controller.abort(); else rl?.close(); };
  process.on('SIGINT', interrupt); rl?.on('SIGINT', interrupt);
  const ask = async text => {
    if (!rl || closed) return '';
    try { return await rl.question(text, controller ? {signal: controller.signal} : {}); } catch { return ''; }
  };
  try {
    if (!['general','coding'].includes(profile)) throw new Error('Profile must be coding or general. General API is separately metered.');
    const baseURL = process.env.ZAI_BASE_URL || (profile === 'coding' ? 'https://api.z.ai/api/coding/paas/v4' : 'https://api.z.ai/api/paas/v4');
    endpointURL(baseURL);
    if (profile === 'coding' && new URL(baseURL).hostname === 'api.z.ai' && !new URL(baseURL).pathname.startsWith('/api/coding/paas/v4')) throw new Error('Coding profile cannot use another Z.ai endpoint. There is no automatic metered API fallback.');
    const maxTools = Number(v['max-tools'] || 20);
    if (!Number.isInteger(maxTools) || maxTools < 1 || maxTools > 100) throw new Error('--max-tools must be an integer between 1 and 100.');
    const reasoning = v.reasoning || process.env.ZAI_REASONING || 'high';
    if (!['low','high','max'].includes(reasoning)) throw new Error('--reasoning must be low, high, or max.');
    const config = {reasoning, apiKey: process.env.ZAI_API_KEY, baseURL, model: v.model || process.env.ZAI_MODEL || 'glm-5.3-flash', maxTools};
    process.stderr.write(accent('\n  Z.ai Workbench') + '  /  0.2.0\n');
    note(`  ${config.model}  |  ${profile}  |  reasoning: ${reasoning}\n  ${cwd}\n\nEndpoint: ${baseURL}\n${profile === 'general' ? 'Billing: separately metered API usage, not Coding Plan quota.' : 'Coding Plan endpoint selected. No metered API fallback. Eligibility details: README.'}\nPrompts and approved tool output are sent to this endpoint.\n${v['no-save'] ? 'Local session saving is off.' : `Conversations and tool results are saved locally in ${stateDir()}.`}\n`);
    if (process.env.ZAI_BASE_URL && interactive && (await ask('Send prompts and your API key to this custom endpoint? [y/N] ')).trim().toLowerCase() !== 'y') return;
    let session = v.resume ? await loadSession(v.resume, cwd) : newSession(cwd);
    const persist = v['no-save'] ? async () => {} : saveSession;
    const approve = async request => {
      if (request.kind === 'read' && v['allow-read']) return true;
      if (!interactive || closed || controller?.signal.aborted) return false;
      note(`\nApproval: ${request.summary}\n${typeof request.details === 'string' ? request.details : JSON.stringify(request.details, null, 2)}`);
      return (await ask('Allow once? [y/N] ')).trim().toLowerCase() === 'y';
    };
    async function turn(prompt) {
      controller = new AbortController();
      const start = Date.now();
      let waiting = true;
      const spinner = color ? setInterval(() => { if (waiting) process.stderr.write(`\r  Thinking ${((Date.now()-start)/1000).toFixed(0)}s...`); }, 400) : null;
      const stopWaiting = () => { if (waiting && color) process.stderr.write('\r\x1b[2K'); waiting = false; };
      try {
        process.stderr.write(accent('  zai  ') + '\n');
        const result = await runTurn({session, prompt, config, signal: controller.signal, approve, persist,
          onText: text => {stopWaiting(); process.stdout.write(clean(text));}, onTool: name => {stopWaiting(); note(`\n  > ${name}`);}});
        process.stdout.write('\n');
        note(`\n  ${((Date.now()-start)/1000).toFixed(1)}s | ${result.tools} tool calls${result.usage?.total_tokens ? ` | ${result.usage.total_tokens} tokens` : ''}${v['no-save'] ? '' : ` | session ${session.id}`}\n`);
      } catch (error) {
        stopWaiting();
        note(`\n${controller.signal.aborted ? 'Cancelled. Completed actions are not rolled back.' : `Error: ${error.message}`}`);
        if (v.prompt) process.exitCode = controller.signal.aborted ? 130 : 1;
      } finally {if (spinner) clearInterval(spinner); stopWaiting(); controller = undefined;}
    }
    if (v.prompt) { await turn(v.prompt); return; }
    note('Type /help for commands. End a line with \\ for multiline input. Each write and command asks first.');
    while (!closed) {
      let input = (await ask('\nyou > ')).trim();
      while (input.endsWith('\\') && !closed) input = input.slice(0,-1) + '\n' + await ask('    > ');
      if (closed || input === '/exit') break;
      if (!input) continue;
      if (input === '/help') { note('/new starts fresh | /status shows settings | /exit quits\nUse --allow-read to approve safe file context for the session.'); continue; }
      if (input === '/new') { session = newSession(cwd); note('Fresh session.'); continue; }
      if (input === '/status') { note(`Model: ${config.model}\nEndpoint: ${baseURL}\nSession: ${session.id}\nTool budget: ${maxTools}\nRead consent: ${Boolean(v['allow-read'])}`); continue; }
      if (input.startsWith('/')) { note('Unknown command. Try /help.'); continue; }
      await turn(input);
    }
  } finally { rl?.close(); process.removeListener('SIGINT', interrupt); }
}
main().catch(error => {process.stderr.write(`Error: ${clean(error.message)}\n`); process.exitCode = 1;});
