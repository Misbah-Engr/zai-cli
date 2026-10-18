// Diagnostics accept only selected JSON fields, never raw response bodies.
const MAX_ERROR_BODY = 16 * 1024;
function safeDetail(value, apiKey, limit = 240) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  let text = String(value);
  // Redact before truncating so a partial credential cannot survive at the boundary.
  for (const secret of [apiKey, apiKey && encodeURIComponent(apiKey)].filter(Boolean)) text = text.split(secret).join('[redacted]');
  text = text
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/https?:\/\/[^\s<>]+/gi, '[redacted URL]')
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, '[redacted authorization]')
    .replace(/\b(?:api[ _-]?key|access[ _-]?token|refresh[ _-]?token|authorization|password|passwd|secret|credential|cookie)\b["']?\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi, '[redacted credential]')
    .replace(/\b(?:sk|key|token)[_-][A-Za-z0-9_.-]+/gi, '[redacted]')
    .replace(/[A-Za-z0-9_+\/=-]{24,}(?:\.[A-Za-z0-9_+\/=-]+)*/g, '[redacted]')
    .replace(/\s+/g, ' ').trim();
  return text.length > limit ? text.slice(0, limit) + '…' : text;
}
async function errorJSON(body) {
  if (!body) return null;
  const reader = body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ERROR_BODY) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch { return null; }
  finally { reader.releaseLock(); }
}
export function providerDetail(payload, apiKey) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';
  const detail = payload.error && typeof payload.error === 'object' && !Array.isArray(payload.error) ? payload.error : payload;
  const code = safeDetail(detail.providerCode ?? detail.error_code ?? detail.code, apiKey, 64);
  const message = safeDetail(detail.message ?? detail.msg, apiKey);
  return [code && `Provider code: ${code}.`, message && `Provider message: ${message}`].filter(Boolean).join(' ');
}
function retryAfter(headers) {
  const value = headers.get('retry-after');
  if (!value || value.length > 64) return '';
  if (/^\d{1,9}$/.test(value)) return ` Retry-After: ${Number(value)} seconds.`;
  // Only a strict HTTP date is accepted; arbitrary header text is never echoed.
  if (/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value) && Number.isFinite(Date.parse(value))) return ` Retry-After: ${new Date(value).toISOString()}.`;
  return '';
}
export async function providerHTTPError(response, apiKey) {
  const detail = providerDetail(await errorJSON(response.body), apiKey);
  const hint = response.status === 401 ? 'Check ZAI_API_KEY and account authentication.' : response.status === 429 ? 'The HTTP status alone does not establish the cause. Check the provider details, account limits, and model/endpoint access.' : 'Check the model, account access, and endpoint.';
  return new Error(`Z.ai returned HTTP ${response.status}.${detail ? ' ' + detail : ''} ${hint}${retryAfter(response.headers)}`);
}
const MAX_RESPONSE = 4 * 1024 * 1024;
export function endpointURL(base) {
  const url = new URL(base);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('API URL must use HTTPS (HTTP is allowed only on loopback for local testing).');
  if (url.username || url.password || url.search || url.hash) throw new Error('API URL cannot include credentials, query parameters, or a fragment.');
  url.pathname = url.pathname.replace(/\/$/, '') + '/chat/completions';
  return url;
}
export async function* sseEvents(body, {withEvent = false} = {}) {
  const decoder = new TextDecoder();
  let pending = '', size = 0;
  for await (const chunk of body) {
    size += chunk.byteLength;
    if (size > MAX_RESPONSE) throw new Error('Provider response exceeded 4 MiB.');
    pending += decoder.decode(chunk, {stream: true});
    let match;
    while ((match = /\r?\n\r?\n/.exec(pending))) {
      const frame = pending.slice(0, match.index);
      pending = pending.slice(match.index + match[0].length);
      const data = frame.split(/\r?\n/).filter(x => x.startsWith('data:')).map(x => x.slice(5).replace(/^ /, '')).join('\n');
      const event = frame.split(/\r?\n/).filter(x => x.startsWith('event:')).at(-1)?.slice(6).trim() || 'message';
      if (data) yield withEvent ? {event, data} : data;
    }
  }
  pending += decoder.decode();
  if (pending.trim()) throw new Error('Provider stream ended with an incomplete event.');
}
export async function complete({apiKey, baseURL, model, reasoning = 'high', messages, tools, signal, onText = () => {}, fetchImpl = fetch}) {
  const timeout = AbortSignal.timeout(180_000);
  const response = await fetchImpl(endpointURL(baseURL), {
    method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: {Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'User-Agent': 'zai-workbench-cli/0.1.0'},
    body: JSON.stringify({model, messages, tools, tool_choice: 'auto', stream: true, tool_stream: true, max_tokens: 8192, ...(/^glm-5\.[23]/.test(model) ? {thinking: {type: 'enabled', clear_thinking: false}, reasoning_effort: reasoning} : {})})
  });
  if (!response.ok) throw await providerHTTPError(response, apiKey);
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
    const detail = providerDetail(await errorJSON(response.body), apiKey);
    throw new Error(`Expected an SSE response from the provider.${detail ? ' ' + detail : ''}`);
  }
  let content = '', reasoningContent = '', finish = null, done = false, usage;
  const calls = new Map();
  for await (const {event: eventType, data} of sseEvents(response.body, {withEvent: true})) {
    if (data === '[DONE]') { done = true; break; }
    let event;
    try { event = JSON.parse(data); } catch { throw new Error('Provider returned malformed stream JSON.'); }
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('Provider returned malformed stream JSON.');
    const errorCode = event.providerCode ?? event.error_code ?? event.code;
    if (eventType === 'error' || event.error || event.type === 'error' || event.success === false || (errorCode != null && String(errorCode) !== '0' && String(errorCode) !== '200')) {
      const detail = providerDetail(event, apiKey);
      throw new Error(`Provider reported an error while streaming.${detail ? ' ' + detail : ''}`);
    }
    usage = event.usage ?? usage;
    const choice = event.choices?.[0];
    if (!choice) continue;
    finish = choice.finish_reason ?? finish;
    const delta = choice.delta ?? {};
    if (typeof delta.content === 'string') { content += delta.content; onText(delta.content); }
    if (typeof delta.reasoning_content === 'string') reasoningContent += delta.reasoning_content;
    for (const patch of delta.tool_calls ?? []) {
      if (!Number.isInteger(patch.index) || patch.index < 0 || patch.index > 31) throw new Error('Invalid streamed tool index.');
      const call = calls.get(patch.index) ?? {id: '', type: 'function', function: {name: '', arguments: ''}};
      if (patch.id) call.id += patch.id;
      if (patch.function?.name) call.function.name += patch.function.name;
      if (typeof patch.function?.arguments === 'string') call.function.arguments += patch.function.arguments;
      else if (patch.function?.arguments) call.function.arguments += JSON.stringify(patch.function.arguments);
      calls.set(patch.index, call);
    }
  }
  if (!done || !finish) throw new Error('Provider stream was interrupted. No tool actions were executed.');
  if (!['stop', 'tool_calls'].includes(finish)) throw new Error(`Provider stopped with an unsupported finish reason. No tool actions were executed.`);
  const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([,v]) => v);
  const ids = new Set();
  for (const call of toolCalls) {
    if (!call.id || !call.function.name || ids.has(call.id)) throw new Error('Provider returned invalid tool calls.');
    ids.add(call.id);
  }
  const message = {role: 'assistant', content: content || null};
  if (reasoningContent) message.reasoning_content = reasoningContent;
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {message, usage};
}
