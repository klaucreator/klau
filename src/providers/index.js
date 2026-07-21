'use strict';

const { sendToAnthropic, streamAnthropic } = require('./anthropic');
const { sendToOpenAICompatible, streamOpenAICompatible } = require('./openai-compatible');

// Picks the provider the user currently has active in settings, falling back to the first
// configured provider if the stored id no longer matches one (e.g. it was removed).
function resolveActiveProvider(settings) {
  return (
    settings.providers.find((p) => p.id === settings.activeProviderId) ||
    settings.providers[0]
  );
}

function assertUsableProvider(provider) {
  if (!provider) throw new Error('No AI provider configured. Add one in plugin settings.');
  if (!provider.apiKey) {
    throw new Error(`No API key set for "${provider.name}". Add one in plugin settings.`);
  }
}

// Non-streaming request; used by the chat sidebar and the Organize feature.
async function sendMessage(messages, provider, systemText) {
  assertUsableProvider(provider);
  if (provider.type === 'anthropic') {
    return await sendToAnthropic(messages, provider, systemText);
  }
  return await sendToOpenAICompatible(messages, provider, systemText);
}

// Streaming request; used by the Agent. onDelta(text) is called repeatedly with the growing
// raw response text as it streams in.
async function streamMessage(messages, provider, systemText, onDelta) {
  assertUsableProvider(provider);
  return provider.type === 'anthropic'
    ? await streamAnthropic(messages, provider, systemText, onDelta)
    : await streamOpenAICompatible(messages, provider, systemText, onDelta);
}

module.exports = {
  resolveActiveProvider,
  assertUsableProvider,
  sendMessage,
  streamMessage,
  // Re-exported for callers (e.g. the agent loop's non-streaming fallback) that need a
  // specific implementation rather than type-based dispatch.
  sendToAnthropic,
  sendToOpenAICompatible,
};
