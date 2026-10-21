import { clean, graphemes, cellWidth } from '../util.mjs';

const LIMIT = 64000;
/** Grapheme-indexed editor. History is explicit and never shares arrow/wheel navigation. */
export class Editor {
  constructor() {
    this.chars = []; this.cursor = 0; this.anchor = null; this.goalColumn = null;
    this.history = []; this.historyIndex = -1; this.savedDraft = '';
    this.undoStack = []; this.redoStack = []; this.lastEdit = null;
  }
  get text() { return this.chars.join(''); }
  get selection() { return this.anchor === null || this.anchor === this.cursor ? null : [Math.min(this.anchor, this.cursor), Math.max(this.anchor, this.cursor)]; }
  get selectedText() { const range = this.selection; return range ? this.chars.slice(...range).join('') : ''; }
  snapshot() { return { text: this.text, cursor: this.cursor, anchor: this.anchor }; }
  restore(value) { this.chars = graphemes(value.text); this.cursor = value.cursor; this.anchor = value.anchor; this.goalColumn = null; }
  set(text) { this.chars = graphemes(clean(text).slice(0, LIMIT)); this.cursor = this.chars.length; this.anchor = null; this.goalColumn = null; this.lastEdit = null; }
  checkpoint(kind = 'change') {
    const now = Date.now();
    if (!this.selection && kind === 'typing' && this.lastEdit?.kind === kind && now - this.lastEdit.at < 600) {
      this.lastEdit.at = now; this.redoStack = []; return;
    }
    this.undoStack.push(this.snapshot()); this.redoStack = [];
    let size = 0;
    for (let i = this.undoStack.length - 1; i >= 0; i--) {
      size += this.undoStack[i].text.length;
      if (size > 2000000 || this.undoStack.length - i > 100) { this.undoStack.splice(0, i + 1); break; }
    }
    this.lastEdit = { kind, at: now };
  }
  removeSelection() {
    const range = this.selection;
    if (!range) return false;
    this.chars.splice(range[0], range[1] - range[0]); this.cursor = range[0]; this.anchor = null; return true;
  }
  insert(text) {
    const incoming = clean(text), range = this.selection;
    const start = range?.[0] ?? this.cursor, end = range?.[1] ?? this.cursor;
    const before = this.chars.slice(0, start).join(''), after = this.chars.slice(end).join('');
    if (before.length + after.length + incoming.length > LIMIT) return false;
    this.checkpoint(incoming.length === 1 && incoming !== '\n' ? 'typing' : 'paste');
    this.chars = graphemes(before + incoming + after); this.cursor = graphemes(before + incoming).length;
    this.anchor = null; this.goalColumn = null; return true;
  }
  remember() {
    const text = this.text;
    if (text && this.history.at(-1) !== text) this.history.push(text);
    if (this.history.length > 100) this.history.shift();
    this.historyIndex = -1; this.savedDraft = ''; this.set(''); this.undoStack = []; this.redoStack = []; return text;
  }
  lineStart(at = this.cursor) { let i = at; while (i > 0 && this.chars[i - 1] !== '\n') i--; return i; }
  lineEnd(at = this.cursor) { let i = at; while (i < this.chars.length && this.chars[i] !== '\n') i++; return i; }
  moveTo(index, extend = false) {
    if (extend && this.anchor === null) this.anchor = this.cursor;
    if (!extend) this.anchor = null;
    this.cursor = Math.max(0, Math.min(this.chars.length, index)); this.lastEdit = null;
  }
  wordBoundary(direction) {
    let i = this.cursor;
    if (direction < 0) {
      while (i > 0 && /\s/u.test(this.chars[i - 1])) i--;
      while (i > 0 && !/\s/u.test(this.chars[i - 1])) i--;
    } else {
      while (i < this.chars.length && !/\s/u.test(this.chars[i])) i++;
      while (i < this.chars.length && /\s/u.test(this.chars[i])) i++;
    }
    return i;
  }
  selectWord(index) {
    if (!this.chars.length) return;
    index = Math.max(0, Math.min(this.chars.length - 1, index));
    const space = /\s/u.test(this.chars[index]); let a = index, b = index + 1;
    while (a > 0 && /\s/u.test(this.chars[a - 1]) === space) a--;
    while (b < this.chars.length && /\s/u.test(this.chars[b]) === space) b++;
    this.anchor = a; this.cursor = b; this.lastEdit = null;
  }
  key(name, columns) {
    const extend = name.startsWith('select-');
    if (extend) name = name.slice(7);
    if (name === 'all') { this.anchor = 0; this.cursor = this.chars.length; this.lastEdit = null; return; }
    if (name === 'undo' || name === 'redo') {
      const source = name === 'undo' ? this.undoStack : this.redoStack, target = name === 'undo' ? this.redoStack : this.undoStack;
      if (source.length) { target.push(this.snapshot()); this.restore(source.pop()); }
      this.lastEdit = null; return;
    }
    if (name === 'history-prev' || name === 'history-next') { this.recall(name === 'history-prev' ? -1 : 1); return; }
    if (name === 'newline') { this.insert('\n'); return; }
    if (['backspace', 'delete', 'kill-left', 'kill-right', 'kill-word', 'cut'].includes(name)) {
      if (name === 'cut' && !this.selection) return;
      this.checkpoint();
      if (this.removeSelection()) return;
      if (name === 'backspace' && this.cursor > 0) this.chars.splice(--this.cursor, 1);
      if (name === 'delete') this.chars.splice(this.cursor, 1);
      if (name === 'kill-left') { const start = this.lineStart(); this.chars.splice(start, this.cursor - start); this.cursor = start; }
      if (name === 'kill-right') this.chars.splice(this.cursor, this.lineEnd() - this.cursor);
      if (name === 'kill-word') { const start = this.wordBoundary(-1); this.chars.splice(start, this.cursor - start); this.cursor = start; }
      this.goalColumn = null; return;
    }
    let target = this.cursor;
    const selected = this.selection;
    if (name === 'left') target = selected && !extend ? selected[0] : this.cursor - 1;
    if (name === 'right') target = selected && !extend ? selected[1] : this.cursor + 1;
    if (name === 'home') target = this.lineStart();
    if (name === 'end') target = this.lineEnd();
    if (name === 'start') target = 0;
    if (name === 'finish') target = this.chars.length;
    if (name === 'word-left') target = this.wordBoundary(-1);
    if (name === 'word-right') target = this.wordBoundary(1);
    if (name === 'up' || name === 'down') {
      if (columns) {
        const layout = layoutEditor(this, columns);
        this.goalColumn ??= layout.cursor.column;
        const row = Math.max(0, Math.min(layout.rows.length - 1, layout.cursor.row + (name === 'up' ? -1 : 1)));
        target = indexAtPosition(layout, row, this.goalColumn);
      } else {
        const start = this.lineStart(), offset = this.cursor - start;
        if (name === 'up' && start > 0) target = Math.min(this.lineStart(start - 1) + offset, start - 1);
        if (name === 'down' && this.lineEnd() < this.chars.length) { const next = this.lineEnd() + 1; target = Math.min(next + offset, this.lineEnd(next)); }
      }
    } else this.goalColumn = null;
    this.moveTo(target, extend);
  }
  recall(direction) {
    if (!this.history.length) return;
    if (this.historyIndex === -1) {
      if (direction > 0) return;
      this.savedDraft = this.text; this.historyIndex = this.history.length;
    }
    this.historyIndex = Math.max(0, Math.min(this.history.length, this.historyIndex + direction));
    this.checkpoint(); this.set(this.historyIndex === this.history.length ? this.savedDraft : this.history[this.historyIndex]);
  }
}
const SEQUENCES = new Map([
  ['\x1b[A', 'up'], ['\x1b[B', 'down'], ['\x1b[C', 'right'], ['\x1b[D', 'left'],
  ['\x1bOA', 'up'], ['\x1bOB', 'down'], ['\x1bOC', 'right'], ['\x1bOD', 'left'],
  ['\x1b[H', 'home'], ['\x1b[F', 'end'], ['\x1bOH', 'home'], ['\x1bOF', 'end'],
  ['\x1b[1~', 'home'], ['\x1b[4~', 'end'], ['\x1b[7~', 'home'], ['\x1b[8~', 'end'],
  ['\x1b[3~', 'delete'], ['\x1b[5~', 'page-up'], ['\x1b[6~', 'page-down'],
  ['\x1b[1;5C', 'word-right'], ['\x1b[1;5D', 'word-left'], ['\x1bb', 'word-left'], ['\x1bf', 'word-right'],
  ['\x1b[1;3A', 'history-prev'], ['\x1b[1;3B', 'history-next'],
  ['\x1b[1;5H', 'transcript-start'], ['\x1b[1;5F', 'transcript-end'],
  ['\x1b\r', 'newline'], ['\x1b\n', 'newline'], ['\x1b[13;2u', 'newline'], ['\x1b[27;2;13~', 'newline'],
  ['\x1b[Z', 'back-tab'], ['\x1b[1;2A', 'select-up'], ['\x1b[1;2B', 'select-down'],
  ['\x1b[1;2C', 'select-right'], ['\x1b[1;2D', 'select-left'], ['\x1b[1;2H', 'select-home'], ['\x1b[1;2F', 'select-end'],
  ['\x1b[1;6C', 'select-word-right'], ['\x1b[1;6D', 'select-word-left'], ['\x1b[1;6H', 'select-start'], ['\x1b[1;6F', 'select-finish'],
  ['\x1b[5;2~', 'page-up'], ['\x1b[6;2~', 'page-down'],
]);
const CONTROLS = new Map([
  ['\r', 'enter'], ['\n', 'newline'], ['\x7f', 'backspace'], ['\b', 'backspace'],
  ['\x03', 'interrupt'], ['\x04', 'eof'], ['\x10', 'palette'], ['\x0f', 'details'],
  ['\x0c', 'redraw'], ['\x01', 'select-all'], ['\x05', 'end'], ['\x15', 'kill-left'],
  ['\x0b', 'kill-right'], ['\x17', 'kill-word'], ['\t', 'tab'], ['\x12', 'history'],
  ['\x1a', 'undo'], ['\x19', 'redo'], ['\x18', 'cut'], ['\x06', 'search'],
]);
export class KeyDecoder {
  constructor(onEvent) { this.onEvent = onEvent; this.buffer = ''; this.paste = false; this.pasted = ''; this.overflow = false; }
  feed(text) {
    if (!this.paste && !this.buffer && text.length > 1 && /[\r\n]/.test(text) && !text.includes('\x1b')) { this.onEvent({ text: clean(text) }); return; }
    this.buffer += text;
    while (this.buffer) {
      if (this.paste) {
        const end = this.buffer.indexOf('\x1b[201~');
        if (end >= 0) {
          this.appendPaste(this.buffer.slice(0, end)); this.buffer = this.buffer.slice(end + 6);
          this.onEvent(this.overflow ? { key: 'paste-overflow' } : { text: clean(this.pasted) });
          this.paste = false; this.pasted = ''; this.overflow = false; continue;
        }
        const count = Math.max(0, this.buffer.length - 5);
        this.appendPaste(this.buffer.slice(0, count)); this.buffer = this.buffer.slice(count); return;
      }
      if (this.buffer.startsWith('\x1b[200~')) { this.buffer = this.buffer.slice(6); this.paste = true; continue; }
      if (this.buffer.startsWith('\x1b')) {
        if (this.buffer.startsWith('\x1b]')) {
          const end = this.buffer.match(/^\x1b\]([^\x07]*?)(?:\x07|\x1b\\)/s);
          if (!end) { if (this.buffer.length > 4096) this.buffer = ''; return; }
          const background = end[1].match(/^11;rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})$/i);
          if (background) this.onEvent({ background: background.slice(1).map(x => parseInt(x, 16) / (16 ** x.length - 1)) });
          this.buffer = this.buffer.slice(end[0].length); continue;
        }
        if (this.buffer.startsWith('\x1b[<')) {
          const match = this.buffer.match(/^\x1b\[<(\d{1,5});(\d{1,5});(\d{1,5})([Mm])/);
          if (!match) { if (this.buffer.length > 32 || !/^\x1b\[<[\d;]*$/.test(this.buffer)) this.buffer = ''; return; }
          this.buffer = this.buffer.slice(match[0].length);
          const code = Number(match[1]), x = Number(match[2]) - 1, y = Number(match[3]) - 1;
          if (x >= 0 && y >= 0 && code < 256) this.onEvent({ mouse: { x, y, button: code & 3, shift: Boolean(code & 4), alt: Boolean(code & 8), ctrl: Boolean(code & 16), action: code & 64 ? ((code & 1) ? 'wheel-down' : 'wheel-up') : match[4] === 'm' ? 'release' : code & 32 ? 'drag' : 'press' } });
          continue;
        }
        if (this.buffer.startsWith('\x1b[M')) {
          if (this.buffer.length < 6) return;
          const code = this.buffer.charCodeAt(3) - 32, x = this.buffer.charCodeAt(4) - 33, y = this.buffer.charCodeAt(5) - 33;
          this.buffer = this.buffer.slice(6);
          if (x >= 0 && y >= 0) this.onEvent({ mouse: { x, y, button: code & 3, shift: Boolean(code & 4), action: code & 64 ? ((code & 1) ? 'wheel-down' : 'wheel-up') : (code & 3) === 3 ? 'release' : code & 32 ? 'drag' : 'press' } });
          continue;
        }
        const match = [...SEQUENCES].find(([sequence]) => this.buffer.startsWith(sequence));
        if (match) { this.buffer = this.buffer.slice(match[0].length); this.onEvent({ key: match[1] }); continue; }
        if (['\x1b[200~', '\x1b[<', '\x1b]', ...SEQUENCES.keys()].some(sequence => sequence.startsWith(this.buffer))) return;
        const unknown = this.buffer.match(/^\x1b\[[0-?]*[ -/]*[@-~]/);
        if (unknown) { this.buffer = this.buffer.slice(unknown[0].length); continue; }
        if (this.buffer.startsWith('\x1b[')) { if (this.buffer.length > 128) this.buffer = ''; return; }
        this.buffer = this.buffer.slice(1); this.onEvent({ key: 'escape' }); continue;
      }
      const char = String.fromCodePoint(this.buffer.codePointAt(0)); this.buffer = this.buffer.slice(char.length);
      const key = CONTROLS.get(char);
      if (key) this.onEvent({ key }); else if (!/[\x00-\x1f\x7f-\x9f]/.test(char)) this.onEvent({ text: char });
    }
  }
  appendPaste(text) { if (this.pasted.length + text.length > LIMIT) this.overflow = true; if (!this.overflow) this.pasted += text; }
  flush() { if (this.paste) return; if (this.buffer === '\x1b') { this.onEvent({ key: 'escape' }); this.buffer = ''; } }
}
export function layoutEditor(editor, columns) {
  columns = Math.max(1, columns);
  const rows = [''], positions = [], starts = [0]; let row = 0, column = 0;
  for (let i = 0; i <= editor.chars.length; i++) {
    const char = editor.chars[i], size = char === '\n' || char === undefined ? 0 : cellWidth(char);
    if (char !== '\n' && char !== undefined && column + size > columns) { rows.push(''); row++; column = 0; starts.push(i); }
    positions.push({ row, column });
    if (i === editor.chars.length) break;
    if (char === '\n') { rows.push(''); row++; column = 0; starts.push(i + 1); continue; }
    rows[row] += char; column += size;
  }
  return { rows, positions, starts, cursor: positions[editor.cursor] || { row: 0, column: 0 }, columns };
}
export function indexAtPosition(layout, row, column) {
  row = Math.max(0, Math.min(layout.rows.length - 1, row)); column = Math.max(0, column);
  let best = layout.starts[row], distance = Infinity;
  for (let i = best; i < layout.positions.length && layout.positions[i].row === row; i++) {
    const d = Math.abs(layout.positions[i].column - column);
    if (d < distance) { best = i; distance = d; }
  }
  if (column >= graphemes(layout.rows[row]).reduce((sum, ch) => sum + cellWidth(ch), 0) && layout.positions[best]?.column < graphemes(layout.rows[row]).reduce((sum, ch) => sum + cellWidth(ch), 0) && layout.starts[row + 1] !== undefined) return layout.starts[row + 1];
  return best;
}
