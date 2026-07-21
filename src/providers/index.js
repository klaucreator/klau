'use strict';

const { sendToAnthropic, streamAnthropic } = require('./anthropic');
const { sendToOpenAICompatible, streamOpenAICompatible } = require('./openai-compatible');
const { sendToTransformersJS, streamTransformersJS } = require('./transformers-js');

function resolveActiveProvider(settings) {
  return (
    settings.providers.find((p) => p.id === settings.activeProviderId) ||
    settings.providers[0]
  );
}

function assertUsableProvider(provider) {
  if (!provider) throw new Error('No AI provider configured. Add one in plugin settings.');
  if (provider.type === 'self-hosted' || provider.type === 'transformers-js') return; // No API key required
  if (!provider.apiKey) {
    throw new Error(`No API key set for "${provider.name}". Add one in plugin settings.`);
  }
}

async function sendMessage(messages, provider, systemText) {
  assertUsableProvider(provider);
  if (provider.type === 'anthropic') return await sendToAnthropic(messages, provider, systemText);
  if (provider.type === 'transformers-js') return await sendToTransformersJS(messages, provider, systemText);
  return await sendToOpenAICompatible(messages, provider, systemText);
}

async function streamMessage(messages, provider, systemText, onDelta, signal) {
  assertUsableProvider(provider);
  if (provider.type === 'anthropic') return await streamAnthropic(messages, provider, systemText, onDelta, signal);
  if (provider.type === 'transformers-js') return await streamTransformersJS(messages, provider, systemText, onDelta, signal);
  return await streamOpenAICompatible(messages, provider, systemText, onDelta, signal);
}

module.exports = {
  resolveActiveProvider,
  assertUsableProvider,
  sendMessage,
  streamMessage,
  sendToAnthropic,
  sendToOpenAICompatible,
};
