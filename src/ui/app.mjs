import { mkdir, open, realpath } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { Editor, KeyDecoder, indexAtPosition } from './input.mjs';
import { Screen, renderFrame } from './render.mjs';
import { WorkspaceState } from '../state.mjs';
import { stateDir, saveConfig } from '../config.mjs';
import { writeJson, readJson, hash, redact, id, abortError, clean, width, takeCells } from '../util.mjs';
import { runProcess, spawnProcess, killTree } from '../process.mjs';
import { NativeBackend } from '../backends/native.mjs';
import { NativeStreamBackend } from '../backends/native-stream.mjs';
import { ZaiBackend } from '../backends/zai.mjs';
import { DemoBackend } from '../backends/demo.mjs';
import { TranscriptJournal } from '../transcript.mjs';
import { resolveRuntime, runtimeEnvironment } from '../runtime.mjs';

export const COMMANDS = [
  { name: '/login', description: 'Sign in through the managed runtime, then return here' },
  { name: '/status', description: 'Inspect connection and task state without stopping work' },
  { name: '/reconnect', description: 'Reconnect to this session without replaying a task' },
  { name: '/search', description: 'Search the locally archived conversation' },
  { name: '/mouse', description: 'Turn mouse editing and scrolling on or off' },
  { name: '/new', description: 'Start a new session without touching your files' },
  { name: '/sessions', description: 'Browse this workspace\'s saved sessions' },
  { name: '/model', description: 'Choose a model for the current session' },
  { name: '/mode', description: 'View permissions; native /mode yolo enables full access' },
  { name: '/diff', description: 'Inspect Git changes, including staged changes' },
  { name: '/compact', description: 'Summarize context while retaining the original session' },
  { name: '/export', description: 'Save the visible conversation as Markdown' },
  { name: '/theme', description: 'Switch dark, light, or monochrome styling' },
  { name: '/help', description: 'Commands, keyboard shortcuts, and safety boundaries' },
  { name: '/quit', description: 'Save your draft and leave the terminal cleanly' },
];
export function createBackend(options) {
  if (options.demo) return new DemoBackend(options);
  if (options.config.backend === 'native-stream') return new NativeStreamBackend(options);
  return options.config.backend === 'zai' ? new ZaiBackend(options) : new NativeBackend(options);
}
export async function trustWorkspace({ cwd, config, ask, trust = false, signal }) {
  if (trust) return;
  const identity = hash(JSON.stringify([cwd, config.backend, config.backend === 'zai' ? config.endpoint : config.runtime]));
  const path = join(stateDir(), 'trust.json');
  const record = await readJson(path, { version: 1, workspaces: {} });
  if (record?.version !== 1 || typeof record.workspaces !== 'object' || !record.workspaces) throw new Error('Invalid trust store. Review it before continuing.');
  if (record.workspaces[identity] === true) return;
  const allowed = await ask({ title: 'Trust this workspace?', risk: 'boundary',
    detail: 'After approval, relevant project content may be sent to the selected model provider. Only open repositories you trust. This is not an OS sandbox.',
    input: `Workspace: ${cwd}\nBackend: ${config.backend}\nDestination: ${config.backend === 'zai' ? config.endpoint : 'Provider configured in your installed ZCode client/runtime'}\n\nFile changes and shell commands still require approval under ZC direct API ask mode. Native execution follows upstream policy. Native stream has no ZC approval channel; other runtime tools and plugins may still have side effects.` }, signal);
  if (!allowed) throw new Error('Workspace trust was not granted. No model session was started.');
  record.workspaces[identity] = true; await writeJson(path, record);
}
export async function gitDiff(cwd) {
  const base = ['--no-optional-locks', '--no-pager', '-c', 'core.fsmonitor=false', 'diff', '--no-ext-diff', '--no-textconv', '--color=never'];
  const unstaged = await runProcess('git', [...base, '--'], { cwd, maxBytes: 48000 });
  if (unstaged.code !== 0) throw new Error('This workspace is not a Git repository, or Git is unavailable.');
  const staged = await runProcess('git', [...base, '--cached', '--'], { cwd, maxBytes: 48000 });
  const untracked = await runProcess('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', 'ls-files', '--others', '--exclude-standard'], { cwd, maxBytes: 12000 });
  return `All workspace changes are shown, not only agent edits.\n\nUnstaged\n${unstaged.output || '(none)'}\nStaged\n${staged.output || '(none)'}\nUntracked paths\n${untracked.output || '(none)'}${unstaged.truncated || staged.truncated || untracked.truncated ? '\n[Diff display truncated. Use Git locally for the full diff.]' : ''}`;
}
export class TerminalApp {
  constructor({ cwd, config, demo = false, trust = false, resume, resumePicker = false, prompt, model, input = process.stdin, output = process.stdout }) {
    Object.assign(this, { cwd, config, demo, trust, resumeId: resume, resumePicker, initialPrompt: prompt, initialModel: model, input, output });
    this.state = new WorkspaceState(); this.editor = new Editor(); this.screen = new Screen(output);
    this.activeConversation = Boolean(resume);
    this.focus = 'editor'; this.expandedTools = new Set(); this.editorStart = 0;
    this.busy = false; this.scroll = 0; this.expanded = false; this.toast = ''; this.branch = '';
    this.state.changed = () => { this.anchorScroll = true; this.schedule(); };
    this.pendingArchive = new Map();
    this.state.onRecord = (entry, transient) => { if (this.journal) this.journal.stage(entry, transient); else if (!this.demo && !this.archiveUnavailable) { this.pendingArchive.set(entry.id, { ...entry }); if (this.pendingArchive.size > 4000) { this.archiveUnavailable = true; this.pendingArchive.clear(); this.notify('Initial transcript exceeded the capture limit. Older history is still owned by the runtime.'); } } };
    this.emit = event => { this.state.apply(event); if (event.type === 'session') this.persistWorkspace(); };
    this.decoder = new KeyDecoder(event => this.handleKey(event));
    this.draftPath = join(stateDir(), 'drafts', hash(cwd + (demo ? ':demo' : '')).slice(0, 24) + '.json');
    this.workspacePath = join(stateDir(), 'workspaces', hash(cwd).slice(0, 24) + '.json');
    this.persistChain = Promise.resolve();
    this.color = config.theme !== 'mono' && !Object.hasOwn(process.env, 'NO_COLOR');
  }
  async run() {
    this.done = new Promise(resolve => { this.resolveDone = resolve; });
    this.onData = text => { this.decoder.feed(text); clearTimeout(this.escapeTimer); this.escapeTimer = setTimeout(() => this.decoder.flush(), 180); this.schedule(); };
    this.onResize = () => { this.screen.invalidate(); this.schedule(); };
    this.onTerm = () => { this.exitCode = 143; void this.close(); };
    this.onInt = () => this.handleKey({ key: 'interrupt' });
    this.onInputEnd = () => { void this.close(); };
    this.onOutputError = () => { void this.close(); };
    this.screen.enter(); this.input.setRawMode(true); this.input.setEncoding('utf8'); this.input.resume();
    this.input.on('data', this.onData); this.input.once('end', this.onInputEnd);
    this.output.on('resize', this.onResize); this.output.on('error', this.onOutputError);
    process.on('SIGTERM', this.onTerm); process.on('SIGINT', this.onInt);
    this.schedule();
    this.clock = setInterval(() => { if (this.busy) this.schedule(); }, 1000);
    this.startupController = new AbortController();
    void (async () => {
      this.busy = true;
      try {
        const draft = await readJson(this.draftPath, { text: '' });
        if (typeof draft?.text === 'string') this.editor.set(draft.text);
        try {
          const branch = await runProcess('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', 'branch', '--show-current'], { cwd: this.cwd, timeout: 2000, maxBytes: 500, signal: this.startupController.signal });
          if (branch.code === 0) this.branch = clean(branch.output.trim());
        } catch { /* Git metadata is optional. */ }
        if (this.closing) return;
        await this.connect(this.resumeId);
        if (this.resumePicker) {
          const sessions = (await this.backend.sessions()).filter(session => session.id !== this.state.sessionId);
          if (sessions.length) this.openPalette(sessions.map(session => ({ name: session.id.slice(0, 8), description: session.title, command: `/resume ${session.id}` })), 'RESUME PROJECT');
          else this.notify('No previous session was found for this project. Start a new task here.');
        }
        this.busy = false; if (!['uncertain', 'disconnected'].includes(this.state.phase)) this.emit({ type: 'status', phase: 'idle' });
        if (this.initialPrompt && !this.closing) await this.submit(this.initialPrompt);
      } catch (error) {
        if (!this.closing) this.emit({ type: 'notice', error: true, text: redact(error.message) });
        await this.backend?.dispose(); this.backend = null;
      } finally { this.busy = false; this.schedule(); }
    })();
    await this.done;
    return this.exitCode || 0;
  }
  async connect(resume) {
    this.activeConversation = Boolean(resume);
    if (!this.demo) await trustWorkspace({ cwd: this.cwd, config: this.config, ask: this.ask, trust: this.trust, signal: this.controller?.signal || this.startupController?.signal });
    if (this.backend) await this.backend.dispose();
    if (this.journal) { await this.journal.close(); this.journal = null; }
    this.pendingArchive.clear(); this.archiveUnavailable = false;
    this.historyEntries = null; this.scroll = 0; this.transcriptSelection = null; this.transcriptCache?.clear();
    this.emit({ type: 'reset' });
    this.emit({ type: 'status', phase: 'connecting', detail: this.demo ? 'Starting offline demo' : 'Starting the runtime' });
    this.backend = createBackend({ cwd: this.cwd, config: this.config, demo: this.demo, emit: this.emit, ask: this.ask });
    try {
      const started = await this.backend.start(resume);
      if (this.initialModel && this.config.backend === 'native') { await this.backend.setModel(this.initialModel); }
      else if (started?.needsModel && started.models?.length) {
        const saved = await readJson(this.workspacePath, {});
        const previous = saved.model;
        if (previous && started.models.some(m => m.value === previous && !m.disabled)) await this.backend.setModel(previous);
        else this.openModels(started.models);
      }
      if (!this.demo && this.state.sessionId) {
        try {
          this.journal = await TranscriptJournal.open(this.cwd, this.config.backend + ':' + this.state.sessionId);
          this.journal.onError = error => this.notify('Transcript archive error: ' + error.message);
          const previousPrompts = [...this.pendingArchive.values()].filter(entry => entry.role === 'user').map(entry => entry.text).slice(-100);
          if (previousPrompts.length) this.editor.history = previousPrompts;
          for (const entry of this.pendingArchive.values()) this.journal.stage(entry);
          this.pendingArchive.clear();
          await this.journal.flush();
        } catch (error) { await this.journal?.close().catch(() => {}); this.journal = null; this.archiveUnavailable = true; this.pendingArchive.clear(); this.emit({ type: 'notice', error: true, text: 'Local transcript archive unavailable: ' + error.message }); }
      }
    } catch (error) { await this.backend.dispose(); this.backend = null; throw error; }
  }
  persistWorkspace() {
    if (this.demo || !this.activeConversation || !this.workspacePath || !this.state.sessionId) return;
    const next = { sessionId: this.state.sessionId, backend: this.config.backend, updatedAt: Date.now() };
    if (this.state.model && !this.state.model.startsWith('No model')) next.model = this.state.model;
    this.persistChain = this.persistChain.then(async () => writeJson(this.workspacePath, { ...await readJson(this.workspacePath, {}), ...next }))
      .catch(error => { this.notify('Workspace preference could not be saved: ' + error.message); });
  }
  handleMouse(mouse) {
    if (!this.screen.mouse || !this.view) return;
    if (mouse.action.startsWith('wheel-')) { this.scrollBy(mouse.action === 'wheel-up' ? 4 : -4); return; }
    if (this.permission) {
      if (mouse.action === 'press' && mouse.button === 0 && mouse.y === this.permissionView?.y) this.permission.allow = mouse.x >= this.permissionView.allowX;
      this.schedule(); return;
    }
    if (this.palette) {
      if (mouse.action === 'press' && mouse.button === 0 && this.paletteView && mouse.y >= this.paletteView.y && mouse.y < this.paletteView.y + this.paletteView.count) {
        const index = this.paletteView.first + mouse.y - this.paletteView.y;
        const second = this.paletteClick?.index === index && Date.now() - this.paletteClick.at < 350;
        this.palette.index = index; this.paletteClick = { index, at: Date.now() };
        if (second) this.handleKey({ key: 'enter' });
      }
      this.schedule(); return;
    }
    const c = this.composer, v = this.view;
    const inComposer = c && mouse.y >= c.y && mouse.y < c.y + c.height && mouse.x >= c.x - 1 && mouse.x < c.x + c.width + 1;
    if (mouse.action === 'press' && mouse.button === 0 && inComposer) {
      this.focus = 'editor'; this.transcriptSelection = null;
      const index = indexAtPosition(c.layout, c.start + mouse.y - c.y, mouse.x - c.x);
      const second = this.lastClick?.zone === 'editor' && this.lastClick.index === index && Date.now() - this.lastClick.at < 350;
      if (second) this.editor.selectWord(index); else this.editor.moveTo(index, mouse.shift);
      this.dragZone = 'editor'; this.dragAnchor = this.editor.anchor ?? index;
      this.lastClick = { zone: 'editor', index, at: Date.now() }; this.schedule(); return;
    }
    if (mouse.action === 'drag' && this.dragZone === 'editor') {
      const row = c.start + mouse.y - c.y;
      const index = indexAtPosition(c.layout, row, Math.max(0, Math.min(c.width, mouse.x - c.x)));
      this.editor.anchor = this.dragAnchor; this.editor.moveTo(index, true); this.schedule(); return;
    }
    if (mouse.action === 'press' && mouse.button === 0 && mouse.y >= v.y && mouse.y < v.y + v.height) {
      this.focus = 'transcript'; this.editor.anchor = null;
      const point = { row: Math.min(v.rows.length - 1, v.start + mouse.y - v.y), column: Math.max(0, mouse.x - v.x) };
      if (point.row < 0) return;
      this.transcriptSelection = { start: point, end: point }; this.dragZone = 'transcript';
      this.toolClick = { x: mouse.x, y: mouse.y, id: v.rows[point.row]?.toolId }; this.schedule(); return;
    }
    if (mouse.action === 'drag' && this.dragZone === 'transcript' && this.transcriptSelection) {
      if (mouse.y < v.y) this.scroll = Math.min(this.maxScroll, this.scroll + 1);
      if (mouse.y >= v.y + v.height) this.scroll = Math.max(0, this.scroll - 1);
      this.transcriptSelection.end = { row: Math.max(0, Math.min(v.rows.length - 1, v.start + mouse.y - v.y)), column: Math.max(0, Math.min(v.width, mouse.x - v.x)) };
      this.schedule(); return;
    }
    if (mouse.action === 'release') {
      if (this.toolClick?.id && this.toolClick.x === mouse.x && this.toolClick.y === mouse.y) {
        const id = this.toolClick.id; this.expandedTools.has(id) ? this.expandedTools.delete(id) : this.expandedTools.add(id); this.transcriptSelection = null;
      }
      this.dragZone = null; this.toolClick = null; this.schedule();
    }
  }
  copySelection() {
    let text = this.editor.selectedText;
    if (!text && this.transcriptSelection && this.view) {
      let { start, end } = this.transcriptSelection;
      if (start.row > end.row || start.row === end.row && start.column > end.column) [start, end] = [end, start];
      text = this.view.rows.slice(start.row, end.row + 1).map((row, i) => {
        const from = i === 0 ? start.column : 0, to = start.row + i === end.row ? end.column : width(row.text || '');
        return takeCells(row.text || '', to).slice(takeCells(row.text || '', from).length);
      }).join('\n');
    }
    if (!text) return false;
    this.clipboard = text;
    if (Buffer.byteLength(text) > 100000) { this.notify('Selection is too large for terminal clipboard transfer. Use /export.'); return true; }
    // Clipboard writes happen only on an explicit user copy/cut gesture.
    const osc = '\x1b]52;c;' + Buffer.from(text).toString('base64') + '\x07';
    this.output.write(process.env.TMUX ? '\x1bPtmux;' + osc.replace(/\x1b/g, '\x1b\x1b') + '\x1b\\' : osc);
    this.notify('Copy requested. Terminal clipboard support is required; /export is the fallback.'); return true;
  }
  scrollBy(amount) {
    if (this.permission) { this.permission.scroll += amount; this.schedule(); return; }
    if (this.palette) { this.palette.index = Math.max(0, Math.min(this.palette.matches.length - 1, this.palette.index - Math.sign(amount) * 3)); this.schedule(); return; }
    this.scroll = Math.max(0, Math.min(this.maxScroll || 0, this.scroll + amount));
    if (amount > 0 && this.scroll >= (this.maxScroll || 0)) void this.pageHistory(-1, amount);
    if (amount < 0 && this.scroll === 0 && this.historyEntries) void this.pageHistory(1, amount);
    this.schedule();
  }
  async pageHistory(direction, amount = 4) {
    if (!this.journal || this.historyBusy) return;
    this.historyBusy = true;
    try {
      await this.journal.flush();
      const entries = this.historyEntries || this.state.entries;
      const first = this.journal.order.indexOf(entries[0]?.id), last = this.journal.order.indexOf(entries.at(-1)?.id);
      if (first < 0 || last < 0 || direction < 0 && first === 0) return;
      const row = this.view?.rows[this.view.start];
      if (direction > 0 && last === this.journal.order.length - 1) { this.historyEntries = null; this.scroll = 0; return; }
      const anchor = row ? this.journal.order.indexOf(row.entryId) : first;
      this.historyEntries = await this.journal.window(direction < 0 ? Math.max(0, anchor) + 1 : Math.max(0, anchor), direction < 0 ? 'backward' : 'forward');
      if (row) this.pendingAnchor = { entryId: row.entryId, entryRow: row.entryRow, move: -amount };
      this.transcriptSelection = null;
    } catch (error) { this.notify('History: ' + error.message); }
    finally { this.historyBusy = false; this.schedule(); }
  }
  async oldestHistory() {
    if (this.journal) {
      try { this.historyEntries = await this.journal.window(0); }
      catch (error) { this.notify('History: ' + error.message); return; }
    }
    this.scroll = Number.MAX_SAFE_INTEGER; this.transcriptSelection = null; this.focus = 'transcript'; this.schedule();
  }
  async jumpToEntry(id) {
    if (this.journal) {
      await this.journal.flush(); const index = this.journal.order.indexOf(id);
      if (index >= 0) this.historyEntries = await this.journal.window(index);
    }
    this.pendingAnchor = { entryId: id, entryRow: 0 }; this.transcriptSelection = null; this.focus = 'transcript'; this.schedule();
  }
  openSearch(query = '') {
    this.openPalette([], 'SEARCH CONVERSATION'); this.palette.search = true; this.palette.query = query;
    if (query) void this.searchArchive(query);
  }
  async searchArchive(query) {
    const palette = this.palette;
    if (!palette?.search) return;
    const needle = query.trim().toLowerCase(); if (needle.length < 2) { palette.items = []; palette.matches = []; this.schedule(); return; }
    const matches = [];
    const collect = entries => {
      for (const e of entries) {
        const content = (e.text || e.output || '').replace(/\n/g, ' '), at = content.toLowerCase().indexOf(needle);
        if (at < 0) continue;
        matches.push({ name: e.role === 'tool' ? e.name || 'Tool' : e.role, description: content.slice(Math.max(0, at - 30), at + 100), action: () => { void this.jumpToEntry(e.id).catch(error => this.notify(error.message)); } });
        if (matches.length >= 100) break;
      }
    };
    try {
      if (this.journal) {
        await this.journal.flush();
        for (let start = 0; start < this.journal.order.length && matches.length < 100; start += 100) {
          if (this.palette !== palette || palette.query !== query) return;
          collect(await this.journal.read(start, 100));
        }
      } else collect(this.state.entries);
      if (this.palette !== palette || palette.query !== query) return;
      palette.items = matches; palette.matches = matches; palette.index = 0; this.schedule();
    } catch (error) { this.notify('Search: ' + error.message); }
  }
  async signIn() {
    if (this.demo || this.config.backend === 'zai') throw new Error('Account login is available in the native backend.');
    const runtime = resolveRuntime(this.config.runtime), resume = this.state.sessionId;
    await this.backend?.dispose(); this.backend = null;
    this.suspended = true; clearTimeout(this.paintTimer); this.paintTimer = null;
    this.input.off('data', this.onData); this.input.setRawMode(false); this.screen.leave(); this.input.pause();
    const swallowInterrupt = () => {};
    process.off('SIGINT', this.onInt); process.on('SIGINT', swallowInterrupt);
    let code;
    try {
      code = await new Promise((resolve, reject) => {
        const child = this.loginChild = spawnProcess(runtime.command, [...runtime.args, 'login', '--oauth', ...(process.env.SSH_CONNECTION || process.env.SSH_TTY ? ['--no-browser'] : [])], { cwd: this.cwd, env: runtimeEnvironment(runtime), stdio: 'inherit' });
        child.once('error', reject); child.once('close', value => { this.loginChild = null; resolve(value); });
      });
    } finally {
      process.off('SIGINT', swallowInterrupt); process.on('SIGINT', this.onInt);
      this.suspended = false;
      if (!this.closing) { this.screen.enter(); this.input.setRawMode(true); this.input.resume(); this.input.on('data', this.onData); this.screen.invalidate(); this.schedule(); }
    }
    if (this.closing) return;
    if (code !== 0) throw new Error('Login did not complete. Existing session was not replayed. Use /login to try explicitly.');
    await this.work(() => this.connect(resume));
    this.notify('Account connected. Your draft is ready; no task was sent automatically.');
  }

  ask = (request, signal) => {
    if (this.closing || signal?.aborted) return Promise.resolve(false);
    if (this.permission) return Promise.reject(new Error('An approval is already open. The extra request was not approved.'));
    return new Promise(resolve => {
      const finish = value => {
        if (this.permission?.finish !== finish) return;
        signal?.removeEventListener('abort', cancel); this.permission = null; this.schedule(); resolve(value);
      };
      const cancel = () => finish(false);
      this.toast = ''; clearTimeout(this.toastTimer);
      this.permission = { ...request, input: redact(request.input || ''), allow: false, scroll: 0, finish };
      signal?.addEventListener('abort', cancel, { once: true });
      this.palette = null; this.schedule();
    });
  };
  schedule() {
    if (this.closing || this.suspended || this.paintTimer) return;
    this.paintTimer = setTimeout(() => {
      this.paintTimer = null;
      if (this.closing) return;
      try { this.screen.paint(renderFrame(this, this.output.columns || 80, this.output.rows || 24, this.color)); }
      catch (error) { this.exitCode = 1; this.fatal = redact(error.message); void this.close(); }
    }, 32);
  }
  notify(text) {
    this.toast = clean(text); clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { this.toast = ''; this.schedule(); }, 4500);
    this.schedule();
  }
  openPalette(items = COMMANDS, title = 'COMMANDS') {
    this.palette = { items, matches: items, query: '', index: 0, title }; this.schedule();
  }
  openModels(models) {
    this.openPalette(models.map(model => ({ name: model.value, description: `${model.label} | ${model.description}`,
      command: `/model ${model.value}`, disabled: model.disabled, disabledReason: model.disabledReason })), 'RUNTIME MODELS');
  }
  handleKey({ key, text, mouse, background }) {
    if (this.closing || this.suspended) return;
    if (background) {
      this.detectedTheme = background[0] * 0.2126 + background[1] * 0.7152 + background[2] * 0.0722 > 0.5 ? 'light' : 'dark';
      if (this.config.theme === 'auto') this.screen.invalidate(); this.schedule(); return;
    }
    if (mouse) { this.handleMouse(mouse); return; }
    if (key === 'interrupt' && !this.permission && !this.palette && this.copySelection()) return;
    if (key === 'cut' && !this.permission && !this.palette && this.editor.selection) { this.copySelection(); this.editor.key('cut'); this.schedule(); return; }
    if (key === 'interrupt') {
      if (this.lastInterrupt && Date.now() - this.lastInterrupt < 1000) { void this.close(); return; }
      this.lastInterrupt = Date.now();
      if (this.busy) { this.controller?.abort(); this.startupController?.abort(); this.permission?.finish(false); this.notify('Stopping. Press Ctrl+C again to quit.'); }
      else this.notify('Press Ctrl+C again within one second to quit. Your draft will be saved.');
      return;
    }
    if (key === 'eof' && !this.editor.text) { void this.close(); return; }
    if (key === 'paste-overflow') { this.notify('Paste exceeds 64,000 characters. Nothing from the paste was submitted.'); return; }
    if (this.permission) {
      if (['left', 'right', 'tab', 'back-tab'].includes(key)) this.permission.allow = !this.permission.allow;
      if (key === 'enter') this.permission.finish(this.permission.allow);
      if (key === 'escape') this.permission.finish(false);
      if (key === 'page-up') this.permission.scroll -= 8;
      if (key === 'page-down') this.permission.scroll += 8;
      this.schedule(); return;
    }
    if (key === 'escape') {
      if (this.palette) this.palette = null;
      else if (this.editor.selection || this.transcriptSelection) { this.editor.anchor = null; this.transcriptSelection = null; }
      else if (this.busy) { this.controller?.abort(); if (!this.controller) { this.startupController?.abort(); void this.backend?.dispose(); } }
      this.schedule(); return;
    }
    if (key === 'history' && !this.palette) {
      this.openPalette([...this.editor.history].reverse().map((text, i) => ({ name: String(i + 1), description: text.replace(/\n/g, ' ').slice(0, 140), action: () => { this.editor.checkpoint(); this.editor.set(text); this.focus = 'editor'; } })), 'PROMPT HISTORY'); return;
    }
    if (key === 'search' && !this.palette) { this.openSearch(); return; }
    if (key === 'palette') { this.palette ? this.palette = null : this.openPalette(); this.schedule(); return; }
    if (this.palette) {
      const p = this.palette;
      if (text) p.query += clean(text).replace(/\n/g, ' ').slice(0, 200 - p.query.length);
      if (key === 'backspace') p.query = [...p.query].slice(0, -1).join('');
      if ((text || key === 'backspace') && p.search) { void this.searchArchive(p.query); this.schedule(); return; }
      if (text || key === 'backspace') { p.matches = p.items.filter(item => (item.name + ' ' + item.description).toLowerCase().includes(p.query.toLowerCase())); p.index = 0; }
      if (key === 'up') p.index = Math.max(0, p.index - 1);
      if (key === 'down') p.index = Math.min(p.matches.length - 1, p.index + 1);
      if (key === 'enter' && p.matches[p.index]) {
        const item = p.matches[p.index];
        if (item.disabled) { this.notify(item.disabledReason || 'The runtime marked this option unavailable.'); return; }
        this.palette = null; if (item.action) item.action(); else void this.command(item.command || item.name);
      }
      this.schedule(); return;
    }
    if (key === 'details') { this.expanded = !this.expanded; this.schedule(); return; }
    if (key === 'redraw') { this.screen.invalidate(); this.schedule(); return; }
    if (key === 'page-up') { this.scrollBy(Math.max(4, (this.output.rows || 24) - 10)); return; }
    if (key === 'page-down') { this.scrollBy(-Math.max(4, (this.output.rows || 24) - 10)); return; }
    if (key === 'transcript-end') { this.historyEntries = null; this.scroll = 0; this.focus = 'editor'; this.transcriptSelection = null; this.schedule(); return; }
    if (key === 'transcript-start') { void this.oldestHistory(); return; }
    if (this.focus === 'transcript' && ['up', 'down', 'home', 'end'].includes(key)) {
      if (key === 'end') { this.historyEntries = null; this.scroll = 0; } else if (key === 'home') { void this.oldestHistory(); } else this.scrollBy(key === 'up' ? 1 : -1);
      this.schedule(); return;
    }
    if (this.focus === 'transcript' && key === 'enter') { this.focus = 'editor'; this.schedule(); return; }
    if (key === 'tab' && this.editor.text.startsWith('/')) {
      const match = COMMANDS.find(c => c.name.startsWith(this.editor.text));
      if (match) this.editor.set(match.name + (['/model', '/mode', '/theme', '/export'].includes(match.name) ? ' ' : ''));
      this.schedule(); return;
    }
    if (key === 'enter') {
      const value = this.editor.text.trim(); if (!value) return;
      if (this.busy && !['/help', '/quit', '/export', '/status', '/search', '/mouse'].includes(value.split(/\s/)[0])) { this.notify('A turn is running. Your draft is kept. Esc stops the turn.'); return; }
      if (value.startsWith('/')) { this.editor.remember(); void this.command(value); }
      else if (!this.backend) this.notify('No runtime is connected. Run /new to retry, or /quit then zc setup.');
      else if (this.backend.needsModel) { void this.command('/model'); }
      else { this.editor.remember(); void this.submit(value); }
      return;
    }
    if (text || key?.startsWith('select-')) { this.focus = 'editor'; this.transcriptSelection = null; }
    if (text && !this.editor.insert(text)) this.notify('Draft limit reached: 64,000 characters.');
    if (key) this.editor.key(key, this.composer?.width);
    this.schedule();
  }
  async work(action) {
    if (this.busy) throw new Error('Stop the current turn first.');
    this.busy = true; this.turnStarted = Date.now(); this.controller = new AbortController(); this.schedule();
    try { await action(this.controller.signal); }
    finally {
      if (this.controller?.signal.aborted) {
        for (const entry of this.state.entries) if (entry.role === 'tool' && ['running', 'queued'].includes(entry.status)) { entry.status = 'cancelled'; this.state.onRecord?.(entry); }
      }
      this.busy = false; this.turnStarted = null; this.controller = null;
      if (!['disconnected', 'uncertain'].includes(this.state.phase)) this.emit({ type: 'status', phase: 'idle' });
      await this.journal?.flush();
    }
  }
  async submit(text) {
    if (this.backend?.needsModel) {
      if (!this.editor.text) this.editor.set(text);
      this.emit({ type: 'notice', text: 'No prompt was sent. Choose a model with /model, then send the draft explicitly.' });
      if (this.backend.modelOptions?.length) this.openModels(this.backend.modelOptions);
      return;
    }
    this.scroll = 0; this.historyEntries = null; this.transcriptSelection = null;
    this.activeConversation = true; this.persistWorkspace();
    try { await this.work(signal => this.backend.send(text, signal)); }
    catch (error) { this.emit({ type: 'notice', error: error.name !== 'AbortError', text: error.name === 'AbortError' ? 'Stopped. Review any completed changes before continuing.' : redact(error.message) }); }
  }
  async command(raw) {
    const match = raw.match(/^(\S+)(?:\s+([\s\S]*))?$/), name = match?.[1], value = match?.[2]?.trim();
    try {
      if (name === '/quit' || name === '/exit') { await this.close(); return; }
      if (name === '/help') {
        this.emit({ type: 'notice', text: COMMANDS.map(c => `${c.name.padEnd(11)} ${c.description}`).join('\n') + '\n\n/resume <exact id> opens a saved session.\nMouse click positions the caret; drag selects. Ctrl+A selects the entire draft; Backspace/Delete removes the selection. Shift+arrows extends a selection. Ctrl+Z/Ctrl+Y undo/redo. Ctrl+C copies a selection via terminal clipboard support. Wheel and Page Up/Down scroll the conversation; they do not recall prompts. Ctrl+R or Alt+Up/Down opens prompt history. Ctrl+Home/Ctrl+End jumps to oldest/latest work. Ctrl+F or /search searches the local transcript. /mouse off releases native terminal selection. Ctrl+O toggles tool details.\nAlt+Enter or Ctrl+J inserts a newline. Bracketed paste never submits itself.\nPermissions default to Deny. Use left/right, then Enter.\nDirect API read-only mode blocks all shell commands, including tests. Native /mode yolo requests full access after one confirmation; /mode ask returns guarded policy (routine actions may be auto-allowed). New/resumed native sessions reset to their launch policy. Native stream uses guarded mode, excludes common write/shell/agent tools, and cannot show ZC tool approvals. Other plugins may have side effects. None is an OS sandbox.' }); return;
      }
      if (name === '/status') {
        const info = this.backend?.inspect ? await this.backend.inspect() : { backend: this.config.backend, sessionId: this.state.sessionId, phase: this.state.phase };
        this.emit({ type: 'notice', text: Object.entries(info).map(([k, v]) => `${k}: ${v}`).join('\n') }); return;
      }
      if (name === '/search') { this.openSearch(value || ''); return; }
      if (name === '/mouse') { if (!['on', 'off'].includes(value)) throw new Error('Use /mouse on or /mouse off.'); this.screen.setMouse(value === 'on'); this.notify(value === 'on' ? 'Mouse editing and scrolling enabled.' : 'Mouse released to the terminal. PgUp/PgDn still scroll the conversation.'); return; }
      if (name === '/export') { await this.export(value); return; }
      if (this.busy) throw new Error('Stop the running turn before changing this setting.');
      if (name === '/login') { await this.signIn(); return; }
      if (name === '/reconnect') { const sessionId = this.state.sessionId; if (!sessionId) throw new Error('No saved session is selected. Use /sessions.'); await this.work(() => this.connect(sessionId)); return; }
      if (name === '/theme') {
        if (!['auto', 'dark', 'light', 'mono'].includes(value)) { this.editor.set('/theme '); this.notify('Choose auto, dark, light, or mono.'); return; }
        this.config.theme = value; await saveConfig(this.config); this.screen.invalidate(); this.schedule(); return;
      }
      if (name === '/new' || name === '/resume') {
        if (name === '/resume' && !value) throw new Error('Use /sessions or /resume followed by an exact session ID.');
        await this.work(() => this.connect(name === '/resume' ? value : undefined)); return;
      }
      if (!this.backend) throw new Error('No runtime is connected. Use /new to retry or run zc setup after exiting.');
      if (name === '/sessions') {
        const sessions = await this.backend.sessions();
        if (!sessions.length) { this.notify('No saved sessions in this workspace.'); return; }
        this.openPalette(sessions.map(s => ({ name: s.id.slice(0, 8), description: s.title, command: `/resume ${s.id}` })), 'SAVED SESSIONS'); return;
      }
      if (name === '/model') {
        if (!value && typeof this.backend.models === 'function') {
          let models; await this.work(async () => { models = await this.backend.models(); });
          if (!models.length) { this.emit({ type: 'notice', error: true, text: 'The runtime returned no model options. Check model configuration in the official ZCode CLI. No model was selected.' }); return; }
          this.openModels(models); return;
        }
        if (!value) {
          if (this.config.backend === 'native-stream') { this.emit({ type: 'notice', text: `Current stream model: ${this.state.model}. Use /model providerId/modelId with an exact reference from your installed client. ZC does not query or invent a stream model catalog.` }); }
          else { this.editor.set('/model '); this.notify(`Current: ${this.state.model}. Enter a Z.ai model identifier.`); }
          return;
        }
        await this.work(() => this.backend.setModel(value)); this.notify(this.config.backend === 'native-stream' ? 'Model reference saved locally; ZCode validates it on the next prompt.' : 'Model selection updated for this session.'); return;
      }
      if (name === '/mode') {
        if (this.config.backend === 'native-stream') { this.emit({ type: 'notice', text: 'Native stream uses guarded mode with a fixed denylist. It does not provide ZC tool approvals or strict read-only. Use /help for the boundary.' }); return; }
        if (this.config.backend === 'native' && !this.demo) {
          if (!value) {
            this.emit({ type: 'notice', text: `Current mode: ${this.backend.mode} (runtime: ${this.backend.runtimeMode || 'unconfirmed'}). /mode yolo enables full access after one confirmation. /mode ask returns to guarded policy, which may auto-allow routine actions. Read-only tool restrictions require a new launch.` }); return;
          }
          if (!['ask', 'yolo', 'read-only'].includes(value)) throw new Error('Choose /mode ask or /mode yolo. No permission change was requested.');
          let result; await this.work(signal => this.backend.setMode(value, signal).then(value => { result = value; }));
          if (result?.declined) { this.notify('Full access was not enabled. The current mode is unchanged.'); return; }
          if (result?.changed) this.emit({ type: 'notice', text: result.mode === 'yolo'
            ? 'YOLO / FULL ACCESS enabled for this session. Ordinary permission prompts are bypassed by the native runtime. Send your task when ready. /mode ask switches back.'
            : 'Returned to ask (runtime: guarded). Routine actions may still be auto-allowed under upstream policy. No prompt was replayed.' });
          else this.notify(`Mode unchanged: ${this.backend.mode}`);
          return;
        }
        if (value === 'yolo') throw new Error('Full access is available only with --backend native, not the direct API, demo, or native-stream backend.');
        if (!['ask', 'read-only'].includes(value)) { this.editor.set('/mode '); this.notify(`Current: ${this.config.mode}. Choose ask or read-only.`); return; }
        await this.work(() => this.backend.setMode(value)); this.config.mode = value; this.notify(`Mode: ${value}`); return;
      }
      if (name === '/compact') { await this.work(signal => this.backend.compact(signal)); return; }
      if (name === '/diff') { this.emit({ type: 'notice', text: await gitDiff(this.cwd) }); return; }
      throw new Error(`Unknown command: ${name}. Use /help or Ctrl+P.`);
    } catch (error) { this.emit({ type: 'notice', error: true, text: redact(error.message) }); }
  }
  async export(path) {
    const target = path ? resolve(this.cwd, path) : join(stateDir(), 'exports', `session-${id()}.md`);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const file = await open(target, 'wx', 0o600);
    try { if (this.journal) await this.journal.exportTo(file); else await file.writeFile(redact(this.state.markdown()) + '\n', 'utf8'); await file.sync(); }
    finally { await file.close(); }
    this.notify(`Exported: ${target}`);
  }
  async close() {
    if (this.closing) return; this.closing = true;
    this.controller?.abort(); this.startupController?.abort(); this.permission?.finish(false);
    clearTimeout(this.paintTimer); clearTimeout(this.escapeTimer); clearTimeout(this.toastTimer); clearInterval(this.clock);
    try {
      // A failing archive must not skip the draft save or terminal restoration.
      for (const action of [() => this.loginChild ? killTree(this.loginChild) : undefined, () => this.backend?.dispose(), () => this.journal?.close(), () => this.persistChain,
        () => writeJson(this.draftPath, { text: redact(this.editor.text) })]) {
        try { await action(); } catch (error) { this.fatal ||= redact(error.message); this.exitCode ||= 1; }
      }
    }
    finally {
      this.input.off('data', this.onData); this.input.off('end', this.onInputEnd);
      this.output.off('resize', this.onResize); this.output.off('error', this.onOutputError);
      process.off('SIGTERM', this.onTerm); process.off('SIGINT', this.onInt);
      try { this.input.setRawMode(false); this.input.pause(); this.screen.leave(); } catch { /* Terminal may already be gone. */ }
      if (this.fatal && !this.output.destroyed) this.output.write(`ZC: ${this.fatal}\n`);
      this.resolveDone?.();
    }
  }
}
