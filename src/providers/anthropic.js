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

// 2048 was too tight for agent turns that combine a tool call with a substantial written
// response (e.g. a long "final" summary) — the model would hit the cap before finishing the
// JSON envelope, producing truncated, unparseable output. This is generous headroom for a
// single turn without being wasteful on providers that bill by allocated tokens.
const MAX_TOKENS = 8192;

async function sendToAnthropic(messages, provider, systemText) {
  const body = {
    model: provider.model,
    max_tokens: MAX_TOKENS,
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
    // The response was cut off by the token cap, not because the model finished. Say so
    // explicitly rather than letting downstream JSON parsing fail with a confusing error.
    throw new Error(
      `Response was cut off after hitting the ${MAX_TOKENS}-token limit before finishing. ` +
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
async function streamAnthropic(messages, provider, systemText, onDelta) {
  const body = {
    model: provider.model,
    max_tokens: MAX_TOKENS,
    stream: true,
    messages: messages.map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
    })),
  };
  if (systemText) body.system = systemText;

  const res = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': provider.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
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
      `Response was cut off after hitting the ${MAX_TOKENS}-token limit before finishing. ` +
      `Try a smaller/simpler step, or ask the agent to keep its final summary shorter.`
    );
  }
  return text;
}

module.exports = { sendToAnthropic, streamAnthropic };
