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

// See anthropic.js's MAX_TOKENS comment: 2048 was too tight for agent turns that combine a
// tool call with a substantial written response. This file previously sent no max_tokens at
// all, leaving it to each provider's own (often small) default — set it explicitly instead.
const MAX_TOKENS = 8192;

async function sendToOpenAICompatible(messages, provider, systemText) {
  const body = {
    model: provider.model,
    max_tokens: MAX_TOKENS,
    messages: systemText ? [{ role: 'system', content: systemText }, ...messages] : messages,
  };

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
  if (parsed.choices?.[0]?.finish_reason === 'length') {
    throw new Error(
      `Response was cut off after hitting the ${MAX_TOKENS}-token limit before finishing. ` +
      `Try a smaller/simpler step, or ask the agent to keep its final summary shorter.`
    );
  }
  return parsed.choices?.[0]?.message?.content || '';
}

// See anthropic.js for notes on why streaming uses raw fetch instead of requestUrl.
async function streamOpenAICompatible(messages, provider, systemText, onDelta) {
  const body = {
    model: provider.model,
    max_tokens: MAX_TOKENS,
    stream: true,
    messages: systemText ? [{ role: 'system', content: systemText }, ...messages] : messages,
  };

  const res = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify(body),
  });

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
    if (evt.choices?.[0]?.finish_reason === 'length') truncated = true;
    const delta = evt.choices?.[0]?.delta?.content;
    return delta ? full + delta : full;
  }, onDelta);

  if (truncated) {
    throw new Error(
      `Response was cut off after hitting the ${MAX_TOKENS}-token limit before finishing. ` +
      `Try a smaller/simpler step, or ask the agent to keep its final summary shorter.`
    );
  }
  return text;
}

module.exports = { sendToOpenAICompatible, streamOpenAICompatible };
