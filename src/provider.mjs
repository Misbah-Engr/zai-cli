const MAX_RESPONSE = 4 * 1024 * 1024;
export function endpointURL(base) {
  const url = new URL(base);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('API URL must use HTTPS (HTTP is allowed only on loopback for local testing).');
  if (url.username || url.password || url.search || url.hash) throw new Error('API URL cannot include credentials, query parameters, or a fragment.');
  url.pathname = url.pathname.replace(/\/$/, '') + '/chat/completions';
  return url;
}
export async function* sseEvents(body) {
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
      if (data) yield data;
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
  if (!response.ok) {
    await response.body?.cancel();
    const hint = response.status === 401 ? 'Check ZAI_API_KEY.' : response.status === 429 ? 'Rate limit or quota reached. Try again later.' : 'Check the model, account access, and endpoint.';
    throw new Error(`Z.ai returned HTTP ${response.status}. ${hint}`);
  }
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('Expected an SSE response from the provider.');
  let content = '', reasoningContent = '', finish = null, done = false, usage;
  const calls = new Map();
  for await (const data of sseEvents(response.body)) {
    if (data === '[DONE]') { done = true; break; }
    let event;
    try { event = JSON.parse(data); } catch { throw new Error('Provider returned malformed stream JSON.'); }
    if (event.error) throw new Error('Provider reported an error while streaming.');
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
  if (!['stop', 'tool_calls'].includes(finish)) throw new Error(`Provider stopped with ${finish}. No tool actions were executed.`);
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
