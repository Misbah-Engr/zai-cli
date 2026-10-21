import { id, delay } from '../util.mjs';
export class DemoBackend {
  constructor({ emit, config }) { this.emit = emit; this.config = config; }
  async start() {
    this.session = { id: 'demo-local', model: 'offline demo' };
    this.emit({ type: 'session', ...this.session });
    this.emit({ type: 'notice', text: 'OFFLINE DEMO. Simulated responses and tool activity. No provider call, command execution, or project edits.' });
    return this.session;
  }
  async send(text, signal) {
    this.emit({ type: 'message', id: id(), role: 'user', text });
    this.emit({ type: 'status', phase: 'working', detail: 'Previewing the interaction' });
    const toolId = id();
    this.emit({ type: 'tool', id: toolId, name: 'read_file', input: { path: 'src/example.ts' }, status: 'running' });
    await delay(400, signal);
    this.emit({ type: 'tool', id: toolId, name: 'read_file', status: 'done', output: '1: export const welcome = "A quieter place to build.";\n\nSimulated output. No file was read.', duration: 400 });
    const messageId = id();
    const response = '## A quieter place to build.\n\nYour composer stays put. Tool activity stays readable. You stay in control.\n\n```ts\nconst agent = {\n  provider: "Z.ai",\n  permissions: "ask first",\n  focus: "your code"\n};\n```\n\nTry **Ctrl+P** for commands, **Ctrl+O** for tool details, and **Page Up** to review the conversation.\n\nThis is an offline interaction preview, not a live model answer. Native account authentication is not implemented in this preview. See the compatibility notes before connecting a real backend.';
    for (const word of response.match(/\S+\s*|\s+/g) || []) {
      this.emit({ type: 'delta', id: messageId, text: word }); await delay(14, signal);
    }
    this.emit({ type: 'status', phase: 'idle' });
  }
  async sessions() { return []; }
  async setModel() { throw new Error('Demo mode does not connect to models.'); }
  async setMode() {}
  async compact() { this.emit({ type: 'notice', text: 'Demo sessions do not need context compaction.' }); }
  async dispose() {}
}
