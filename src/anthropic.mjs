// Optional public Anthropic-compatible API transport. This does not emulate
// ZCode account login, client signing, gateway routing, or its entitlement.
import {providerHTTPError, providerDetail, sseEvents} from './provider.mjs';

export function anthropicEndpointURL(base) {
  const url = new URL(base);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('API URL must use HTTPS (HTTP is allowed only on loopback for local testing).');
  if (url.username || url.password || url.search || url.hash) throw new Error('API URL cannot include credentials, query parameters, or a fragment.');
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path + (path.endsWith('/v1') ? '/messages' : '/v1/messages');
  return url;
}

export function anthropicRequest({model, messages, tools = [], reasoning = 'high'}) {
  const system = [], converted = [];
  const append = (role, content) => {
    const last = converted.at(-1);
    if (last?.role === role) last.content.push(...content);
    else converted.push({role, content});
  };
  for (const message of messages) {
    if (message.role === 'system') { if (message.content) system.push({type: 'text', text: message.content}); continue; }
    if (message.role === 'tool') { append('user', [{type: 'tool_result', tool_use_id: message.tool_call_id, content: message.content}]); continue; }
    if (!['user', 'assistant'].includes(message.role)) throw new Error('Unsupported message role for Anthropic transport.');
    const content = [];
    // Preserve authenticated thinking blocks when the endpoint returns them.
    if (message.role === 'assistant' && Array.isArray(message.anthropic_thinking)) content.push(...message.anthropic_thinking);
    if (message.content) content.push({type: 'text', text: message.content});
    for (const call of message.tool_calls ?? []) {
      let input;
      try { input = JSON.parse(call.function.arguments); } catch { throw new Error('Invalid tool arguments in conversation history.'); }
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Tool arguments must be an object.');
      content.push({type: 'tool_use', id: call.id, name: call.function.name, input});
    }
    if (content.length) append(message.role, content);
  }
  return {
    model, max_tokens: 8192, stream: true, messages: converted,
    ...(system.length ? {system} : {}),
    ...(tools.length ? {tools: tools.map(({function: tool}) => ({name: tool.name, description: tool.description, input_schema: tool.parameters})), tool_choice: {type: 'auto'}} : {}),
    ...(/^glm-5\.3(?:-flash)?$/i.test(model) ? {thinking: {type: 'enabled'}, output_config: {effort: reasoning}} : {})
  };
}

export async function completeAnthropic({apiKey, baseURL, model, reasoning = 'high', messages, tools, signal, onText = () => {}, fetchImpl = fetch}) {
  const timeout = AbortSignal.timeout(180_000);
  const response = await fetchImpl(anthropicEndpointURL(baseURL), {
    method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: {Authorization: `Bearer ${apiKey}`, 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json', 'User-Agent': 'zai-workbench-cli/0.1.0'},
    body: JSON.stringify(anthropicRequest({model, messages, tools, reasoning}))
  });
  if (!response.ok) throw await providerHTTPError(response, apiKey);
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('Expected an SSE response from the provider.');
  let started = false, done = false, finish, content = '', reasoningContent = '', usage;
  const blocks = new Map();
  for await (const {event: eventName, data} of sseEvents(response.body, {withEvent: true})) {
    let event;
    try { event = JSON.parse(data); } catch { throw new Error('Provider returned malformed stream JSON.'); }
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('Provider returned malformed stream JSON.');
    if (eventName === 'error' || event.type === 'error' || event.error || event.success === false || (event.code != null && event.code !== 0 && event.code !== '0')) throw new Error(`Provider reported an error while streaming. ${providerDetail(event, apiKey)}`.trim());
    if (event.type === 'ping') continue;
    if (event.type === 'message_start') {
      if (started) throw new Error('Provider returned duplicate message start.');
      started = true; usage = event.message?.usage; continue;
    }
    if (!started) throw new Error('Provider stream missing message start.');
    if (event.type === 'message_stop') { done = true; break; }
    if (event.type === 'message_delta') { finish = event.delta?.stop_reason ?? finish; usage = {...usage, ...event.usage}; continue; }
    if (!['content_block_start', 'content_block_delta', 'content_block_stop'].includes(event.type)) continue;
    if (!Number.isInteger(event.index) || event.index < 0 || event.index > 255) throw new Error('Invalid streamed content index.');
    if (event.type === 'content_block_start') {
      if (blocks.has(event.index)) throw new Error('Provider returned duplicate content block.');
      const block = event.content_block;
      if (!block || !['text', 'thinking', 'redacted_thinking', 'tool_use'].includes(block.type)) throw new Error('Unsupported provider content block.');
      blocks.set(event.index, {...block, ...(block.type === 'text' ? {text: block.text ?? ''} : {}), ...(block.type === 'thinking' ? {thinking: block.thinking ?? ''} : {}), partial: '', closed: false});
      if (block.type === 'text' && typeof block.text === 'string') { content += block.text; onText(block.text); }
      if (block.type === 'thinking' && typeof block.thinking === 'string') reasoningContent += block.thinking;
      continue;
    }
    const block = blocks.get(event.index);
    if (!block || block.closed) throw new Error('Provider returned an invalid content sequence.');
    if (event.type === 'content_block_stop') { block.closed = true; continue; }
    const delta = event.delta ?? {};
    if (delta.type === 'text_delta' && block.type === 'text' && typeof delta.text === 'string') { content += delta.text; block.text += delta.text; onText(delta.text); }
    else if (delta.type === 'thinking_delta' && block.type === 'thinking' && typeof delta.thinking === 'string') { reasoningContent += delta.thinking; block.thinking += delta.thinking; }
    else if (delta.type === 'signature_delta' && block.type === 'thinking' && typeof delta.signature === 'string') block.signature = (block.signature ?? '') + delta.signature;
    else if (delta.type === 'input_json_delta' && block.type === 'tool_use' && typeof delta.partial_json === 'string') block.partial += delta.partial_json;
    else throw new Error('Provider returned an invalid content delta.');
  }
  if (!done || !finish || [...blocks.values()].some(block => !block.closed)) throw new Error('Provider stream was interrupted. No tool actions were executed.');
  if (!['end_turn', 'tool_use', 'stop_sequence'].includes(finish)) throw new Error('Provider stopped with an unsupported finish reason. No tool actions were executed.');
  const toolCalls = [], thinking = [], ids = new Set();
  for (const [, block] of [...blocks.entries()].sort(([a], [b]) => a - b)) {
    if (block.type === 'thinking' && block.signature) thinking.push({type: 'thinking', thinking: block.thinking ?? '', signature: block.signature});
    if (block.type === 'redacted_thinking') thinking.push({type: 'redacted_thinking', data: block.data});
    if (block.type !== 'tool_use') continue;
    if (!block.id || !block.name || ids.has(block.id)) throw new Error('Provider returned invalid tool calls.');
    let input;
    try { input = block.partial ? JSON.parse(block.partial) : block.input; } catch { throw new Error('Provider returned invalid tool arguments.'); }
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Provider returned invalid tool arguments.');
    ids.add(block.id); toolCalls.push({id: block.id, type: 'function', function: {name: block.name, arguments: JSON.stringify(input)}});
  }
  if ((toolCalls.length > 0) !== (finish === 'tool_use')) throw new Error('Provider returned inconsistent tool completion. No tool actions were executed.');
  const message = {role: 'assistant', content: content || null};
  if (reasoningContent) message.reasoning_content = reasoningContent;
  if (thinking.length) message.anthropic_thinking = thinking;
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {message, usage: usage ? {prompt_tokens: usage.input_tokens, completion_tokens: usage.output_tokens} : undefined};
}
