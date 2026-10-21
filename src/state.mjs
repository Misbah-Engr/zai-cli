import { id, bounded, clean } from './util.mjs';

/** Presentation state only. Providers own their histories and execution state. */
export class WorkspaceState {
  constructor() {
    this.entries = []; this.onRecord = () => {}; this.phase = 'idle'; this.detail = ''; this.model = '';
    this.mode = ''; this.runtimeMode = ''; this.sessionId = ''; this.usage = null; this.changed = () => {};
  }
  apply(event) {
    switch (event.type) {
      case 'message': this.upsert({ id: event.id || id(), role: event.role || 'assistant', text: bounded(event.text, 120000) }); break;
      case 'delta': {
        let entry = this.entries.find(item => item.id === event.id);
        if (!entry) { entry = { id: event.id, role: event.role || 'assistant', text: '' }; this.entries.push(entry); }
        entry.text = bounded(entry.text + event.text, 120000); this.onRecord(entry, true); break;
      }
      case 'tool': this.upsert({ ...event, type: undefined, role: 'tool', text: '', output: event.output === undefined ? undefined : bounded(event.output, 24000) }); break;
      case 'notice': this.upsert({ id: id(), role: event.error ? 'error' : 'notice', text: bounded(event.text, 24000) }); break;
      case 'status': this.phase = event.phase; this.detail = clean(event.detail || ''); break;
      case 'session': this.sessionId = event.id; this.model = event.model || ''; break;
      case 'mode': this.mode = event.mode; this.runtimeMode = event.runtimeMode; break;
      case 'usage': this.usage = event.usage; break;
      case 'reset': this.entries = []; this.sessionId = ''; this.model = ''; this.usage = null; this.mode = ''; this.runtimeMode = ''; break;
    }
    if (this.entries.length > 400) this.entries.splice(0, this.entries.length - 400);
    // Keep rendering and session export bounded even during long investigations.
    let budget = 1500000;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      budget -= (this.entries[i].text?.length || 0) + (this.entries[i].output?.length || 0);
      if (budget < 0) { this.entries.splice(0, i + 1); break; }
    }
    this.changed();
  }
  upsert(value) {
    const entry = this.entries.find(item => item.id === value.id);
    const fields = Object.fromEntries(Object.entries(value).filter(([,v]) => v !== undefined));
    if (entry) Object.assign(entry, fields); else this.entries.push(fields);
    this.onRecord(entry || fields);
  }
  markdown() {
    return ['# ZC session', '', `Session: ${this.sessionId || 'not started'}`, `Model: ${this.model || 'not selected'}`, '',
      ...this.entries.flatMap(entry => entry.role === 'tool'
        ? [`## Tool: ${clean(entry.name)} (${clean(entry.status)})`, '', clean(entry.output || ''), '']
        : [`## ${entry.role === 'user' ? 'You' : entry.role === 'assistant' ? 'ZC' : entry.role}`, '', clean(entry.text), ''])].join('\n');
  }
}
