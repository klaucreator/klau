'use strict';

const providers = require('../providers');
const { AGENT_SYSTEM_PROMPT } = require('./system-prompt');
const { parseLenientJson } = require('../core/json-utils');

// How many of the most recent tool-call/tool-result exchanges are sent to the model in full
// on each turn. Older ones are collapsed into a one-line summary so a long-running (many-step)
// agent doesn't keep growing the request forever — this matters most for smaller local models
// with limited context windows.
const AGENT_CONTEXT_KEEP_STEPS = 8;

// transcript[0] is always the original goal message. After that, entries alternate
// assistant (tool call) / user (tool result). Keep the goal plus the most recent N pairs
// verbatim; fold anything older into a short note so the model knows steps happened without
// re-sending their full content.
function compactTranscriptForApi(transcript) {
  const keep = AGENT_CONTEXT_KEEP_STEPS * 2;
  if (transcript.length <= 1 + keep) return transcript;
  const goal = transcript[0];
  const recent = transcript.slice(-keep);
  const olderPairs = Math.floor((transcript.length - 1 - recent.length) / 2);
  const summary = {
    role: 'user',
    content: `(${olderPairs} earlier step(s) omitted here to keep this request a reasonable size — ` +
      `you already completed them and saw their results. Continue toward the goal from here.)`,
  };
  return [goal, summary, ...recent];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Network hiccups and provider-side overload are worth a couple of automatic
// retries; anything else (bad API key, malformed request, model refusing) is not.
function isRetryableAgentError(err) {
  if (err && [429, 500, 502, 503, 504, 529].includes(err.status)) return true;
  const msg = (err && err.message || '').toLowerCase();
  return (
    msg.includes('network') ||
    msg.includes('fetch failed') ||
    msg.includes('econnreset') ||
    msg.includes('timeout') ||
    msg.includes('overloaded')
  );
}

// One attempt: try the streaming request first so onDelta gets live text; if the failure isn't
// a real API error (no .status — meaning fetch/streaming itself didn't work in this
// environment) fall back to the reliable non-streaming request instead of giving up.
async function agentCallOnce(apiMessages, provider, systemText, onDelta) {
  try {
    return await providers.streamMessage(apiMessages, provider, systemText, onDelta);
  } catch (streamErr) {
    if (streamErr.status) throw streamErr;
    return await providers.sendMessage(apiMessages, provider, systemText);
  }
}

// onDelta(text), if given, is called repeatedly with the growing raw response text as it
// streams in — purely cosmetic (the caller just displays it), the return value is always the
// complete text. Retries automatically (with backoff) on transient errors; a real API error
// (bad key, invalid request, model-side refusal) is thrown immediately without retrying.
//
// `provider` is the active AI provider config; `extraSystemPrompt` is the user's own
// Settings > System prompt text (appended after the role text, if any).
async function agentCall(transcript, roleText, onDelta, { provider, extraSystemPrompt }) {
  providers.assertUsableProvider(provider);

  let systemText = AGENT_SYSTEM_PROMPT;
  if (roleText) {
    systemText += `\n\nYour specific role on this team for the current task: ${roleText}`;
  }
  if (extraSystemPrompt) {
    systemText += `\n\n${extraSystemPrompt}`;
  }

  const apiMessages = compactTranscriptForApi(transcript);
  const maxAttempts = 3;
  let lastErr;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await agentCallOnce(apiMessages, provider, systemText, onDelta);
    } catch (err) {
      lastErr = err;
      if (!isRetryableAgentError(err) || attempt === maxAttempts) throw err;
      if (onDelta) {
        onDelta(`(transient error: ${err.message} — retrying, attempt ${attempt + 1}/${maxAttempts}…)`);
      }
      await sleep(800 * attempt);
    }
  }
  throw lastErr;
}

// Some local/self-hosted models (commonly Qwen- or Hermes-tuned ones) are fine-tuned hard
// enough on their own native tool-call format that they ignore the "respond with ONLY a JSON
// object" instruction in the system prompt and emit it anyway:
//   <tool_call>tool_name<arg_key>key</arg_key><arg_value>value</arg_value>...</tool_call>
// That has no `{`/`}` at all, so the JSON-slicing fallback below can never catch it. Recognize
// this shape specifically and translate it into the same {tool, args} object the rest of the
// agent loop already expects, instead of surfacing a raw parse error to the user.
const XML_TOOL_CALL_RE = /<tool_call>\s*([a-zA-Z0-9_]+)\s*([\s\S]*?)<\/tool_call>/i;
const XML_ARG_PAIR_RE = /<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/gi;

function parseXmlToolCall(text) {
  const match = text.match(XML_TOOL_CALL_RE);
  if (!match) return null;
  const tool = match[1].trim();
  const args = {};
  const argsBlob = match[2];
  let argMatch;
  XML_ARG_PAIR_RE.lastIndex = 0;
  while ((argMatch = XML_ARG_PAIR_RE.exec(argsBlob))) {
    args[argMatch[1].trim()] = argMatch[2].trim();
  }
  return {
    thought: '(model replied using its native XML tool-call format instead of JSON — recovered automatically)',
    tool,
    args,
  };
}

// Agent replies are expected to be a single JSON object, optionally wrapped in code fences,
// with stray prose around it, or containing raw (unescaped) control characters inside string
// values, or cut off before its closing brackets — parseLenientJson (shared with the non-TS
// agent loop in json-utils.js) tolerates all of these before we fall back to the XML tool-call
// shape above and finally give up.
function parseAgentResponse(raw) {
  try {
    return parseLenientJson(raw);
  } catch (e) {
    const xmlToolCall = parseXmlToolCall(raw);
    if (xmlToolCall) return xmlToolCall;
    throw new Error(`Could not parse agent response as JSON:\n\n${raw}`);
  }
}

module.exports = {
  AGENT_CONTEXT_KEEP_STEPS,
  compactTranscriptForApi,
  sleep,
  isRetryableAgentError,
  agentCall,
  parseAgentResponse,
};
