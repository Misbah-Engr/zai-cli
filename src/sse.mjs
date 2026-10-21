import { throwIfAborted, isRecord } from './util.mjs';

/** Parse SSE at the byte boundary, including UTF-8 and CRLF split across chunks. */
export async function* sseData(stream, { signal, maxEventBytes = 1024 * 1024 } = {}) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', data = [], eventBytes = 0;
  const accept = line => {
    if (!line) { const value = data.length ? data.join('\n') : undefined; data = []; eventBytes = 0; return value; }
    if (line.startsWith('data:')) {
      const value = line.slice(5).replace(/^ /, '');
      eventBytes += Buffer.byteLength(value);
      if (eventBytes > maxEventBytes) throw new Error('Provider event exceeded the byte limit.');
      data.push(value);
    }
    return undefined;
  };
  for await (const bytes of stream) {
    throwIfAborted(signal);
    buffer += typeof bytes === 'string' ? bytes : decoder.decode(bytes, { stream: true });
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).replace(/\r$/, ''); buffer = buffer.slice(i + 1);
      const value = accept(line); if (value !== undefined) yield value;
    }
    if (Buffer.byteLength(buffer) > maxEventBytes) throw new Error('Provider line exceeded the byte limit.');
  }
  buffer += decoder.decode();
  if (buffer) { const value = accept(buffer.replace(/\r$/, '')); if (value !== undefined) yield value; }
  const tail = accept(''); if (tail !== undefined) yield tail;
}

export async function collectCompletion(body, { signal, onText = () => {}, onThinking = () => {} } = {}) {
  const result = { content: '', reasoning_content: '', tool_calls: [], usage: null };
  const tools = new Map(); let finish, done = false, totalBytes = 0;
  for await (const data of sseData(body, { signal })) {
    if (data === '[DONE]') { done = true; break; }
    totalBytes += Buffer.byteLength(data);
    if (totalBytes > 16 * 1024 * 1024) throw new Error('Provider completion exceeded the byte limit.');
    let event;
    try { event = JSON.parse(data); } catch { throw new Error('Provider returned invalid streaming JSON. No tools were executed.'); }
    if (!isRecord(event)) throw new Error('Provider returned a malformed event.');
    if (event.error) throw new Error(`Provider error: ${event.error.message || 'request failed'}`);
    if (event.usage) result.usage = event.usage;
    const choice = event.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finish = choice.finish_reason;
    const delta = choice.delta || {};
    if (typeof delta.content === 'string') { result.content += delta.content; onText(delta.content); }
    if (typeof delta.reasoning_content === 'string') { result.reasoning_content += delta.reasoning_content; onThinking(); }
    for (const call of delta.tool_calls || []) {
      if (!Number.isInteger(call.index) || call.index < 0 || call.index >= 32) throw new Error('Invalid provider tool index.');
      const target = tools.get(call.index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (call.id) target.id = call.id;
      if (call.function?.name) target.function.name += call.function.name;
      if (call.function?.arguments) target.function.arguments += call.function.arguments;
      if (target.function.arguments.length > 512000) throw new Error('Tool arguments exceeded the size limit.');
      tools.set(call.index, target);
    }
  }
  if (!done || !['stop', 'tool_calls'].includes(finish)) throw new Error(`Provider stream ended without a complete answer (${finish || 'disconnected'}). No tools from this response were executed.`);
  result.tool_calls = [...tools.entries()].sort(([a],[b]) => a - b).map(([,v]) => v);
  const seen = new Set();
  for (const tool of result.tool_calls) {
    if (typeof tool.id !== 'string' || !tool.id || tool.id.length > 256 || seen.has(tool.id) || !tool.function.name) throw new Error('Invalid or duplicate provider tool call.');
    seen.add(tool.id);
    try { if (!isRecord(JSON.parse(tool.function.arguments))) throw new Error(); }
    catch { throw new Error('Tool arguments were incomplete or invalid. No tools from this response were executed.'); }
  }
  if (result.tool_calls.length && finish !== 'tool_calls') throw new Error('Provider tool completion marker did not match its calls.');
  return result;
}
