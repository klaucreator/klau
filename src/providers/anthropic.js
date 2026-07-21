'use strict';

const { requestUrl } = require('obsidian');
const { readSse } = require('./sse');

// requestUrl's `res.json` is a getter that runs JSON.parse(res.text) on every access — if the
// body isn't clean JSON (an error/HTML page from a proxy, a truncated response, a misconfigured
// baseUrl hitting the wrong endpoint), that throws a raw, contextless SyntaxError straight out of
// the getter. Read res.text once and parse it ourselves so a bad body becomes a clear error
// instead of an opaque "Unexpected non-whitespace character..." crash.
function safeJson(res) {
  try {
    return JSON.parse(res.text);
  } catch (e) {
    const snippet = (res.text || '').slice(0, 200);
    throw new Error(
      `Anthropic returned a non-JSON response (HTTP ${res.status}). This usually means the ` +
      `base URL is wrong or pointing at something other than the API. Response started with: ${snippet || '(empty)'}`
    );
  }
}

async function sendToAnthropic(messages, provider, systemText) {
  const maxTokens = provider.maxTokens || 8192;
  const body = {
    model: provider.model,
    max_tokens: maxTokens,
    messages: messages.map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
    })),
  };
  if (systemText) body.system = systemText;

  const res = await requestUrl({
    url: `${provider.baseUrl.replace(/\/$/, '')}/v1/messages`,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': provider.apiKey,
      'anthropic-version': '2023-06-01',
      // Required so Anthropic's API accepts calls made from inside Obsidian's renderer.
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
    throw: false,
  });

  if (res.status < 200 || res.status >= 300) {
    let errMsg = res.text || `HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(res.text);
      errMsg = parsed?.error?.message || errMsg;
    } catch (e) {
      // Body wasn't JSON — fall back to the raw text (already assigned above) rather than
      // letting a getter-triggered parse failure mask the real HTTP error.
    }
    const err = new Error(errMsg);
    err.status = res.status;
    throw err;
  }

  const parsed = safeJson(res);
  if (parsed.stop_reason === 'max_tokens') {
    throw new Error(
      `Response was cut off after hitting the ${maxTokens}-token limit before finishing. ` +
      `Try a smaller/simpler step, or ask the agent to keep its final summary shorter.`
    );
  }
  const content = parsed.content || [];
  return content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

// --- Streaming variant (Agent only): same request as above but with stream:true, read via ---
// fetch's ReadableStream and reported incrementally through onDelta(fullTextSoFar). requestUrl
// (used by sendToAnthropic) can't stream, so this uses plain fetch instead; if fetch or the
// stream reading itself fails (rather than the API returning an error), the caller falls back
// to the non-streaming request so the agent still works in environments where this doesn't apply.
async function streamAnthropic(messages, provider, systemText, onDelta, signal) {
  const maxTokens = provider.maxTokens || 8192;
  const body = {
    model: provider.model,
    max_tokens: maxTokens,
    stream: true,
    messages: messages.map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
    })),
  };
  if (systemText) body.system = systemText;

  const timeout = provider.timeoutMs || 120000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  const combinedSignal = signal ? combineSignals(signal, controller.signal) : controller.signal;

  const res = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': provider.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
    signal: combinedSignal,
  });
  clearTimeout(timeoutId);

  if (!res.ok || !res.body) {
    let errMsg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      errMsg = j?.error?.message || errMsg;
    } catch (e) {
      // response wasn't JSON; keep the generic HTTP status message
    }
    const err = new Error(errMsg);
    err.status = res.status;
    throw err;
  }

  let truncated = false;
  const text = await readSse(res.body, (evt, full) => {
    if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
      return full + evt.delta.text;
    }
    if (evt.type === 'message_delta' && evt.delta?.stop_reason === 'max_tokens') {
      truncated = true;
    }
    return full;
  }, onDelta);

  if (truncated) {
    throw new Error(
      `Response was cut off after hitting the ${maxTokens}-token limit before finishing. ` +
      `Try a smaller/simpler step, or ask the agent to keep its final summary shorter.`
    );
  }
  return text;
}

function combineSignals(s1, s2) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  s1.addEventListener('abort', onAbort);
  s2.addEventListener('abort', onAbort);
  if (s1.aborted || s2.aborted) controller.abort();
  return controller.signal;
}

module.exports = { sendToAnthropic, streamAnthropic };
