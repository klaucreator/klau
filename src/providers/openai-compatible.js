'use strict';

const { requestUrl } = require('obsidian');
const { readSse } = require('./sse');

// See anthropic.js's safeJson for why this exists: requestUrl's `res.json` getter throws a raw,
// contextless SyntaxError if the body isn't clean JSON, instead of a message that says what
// actually went wrong.
function safeJson(res) {
  try {
    return JSON.parse(res.text);
  } catch (e) {
    const snippet = (res.text || '').slice(0, 200);
    throw new Error(
      `Provider returned a non-JSON response (HTTP ${res.status}). This usually means the ` +
      `base URL is wrong or pointing at something other than the API. Response started with: ${snippet || '(empty)'}`
    );
  }
}

async function sendToOpenAICompatible(messages, provider, systemText) {
  const maxTokens = provider.maxTokens || -1;
  const body = {
    model: provider.model,
    messages: systemText ? [{ role: 'system', content: systemText }, ...messages] : messages,
  };
  if (maxTokens > 0) body.max_tokens = maxTokens;

  const res = await requestUrl({
    url: `${provider.baseUrl.replace(/\/$/, '')}/chat/completions`,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${provider.apiKey}`,
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
  if (maxTokens > 0 && parsed.choices?.[0]?.finish_reason === 'length') {
    throw new Error(
      `Response was cut off after hitting the ${maxTokens}-token limit before finishing. ` +
      `Try a smaller/simpler step, or ask the agent to keep its final summary shorter.`
    );
  }
  return parsed.choices?.[0]?.message?.content || '';
}

async function streamOpenAICompatible(messages, provider, systemText, onDelta, signal) {
  const maxTokens = provider.maxTokens || -1;
  const body = {
    model: provider.model,
    stream: true,
    messages: systemText ? [{ role: 'system', content: systemText }, ...messages] : messages,
  };
  if (maxTokens > 0) body.max_tokens = maxTokens;

  const timeout = provider.timeoutMs || 120000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  const combinedSignal = signal ? combineSignals(signal, controller.signal) : controller.signal;

  const res = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${provider.apiKey}`,
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
    if (maxTokens > 0 && evt.choices?.[0]?.finish_reason === 'length') truncated = true;
    const delta = evt.choices?.[0]?.delta?.content;
    return delta ? full + delta : full;
  }, onDelta);

  if (maxTokens > 0 && truncated) {
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

module.exports = { sendToOpenAICompatible, streamOpenAICompatible };
