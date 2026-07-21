'use strict';

async function loadTransformers() {
  if (typeof window !== 'undefined' && window.Transformers) return window.Transformers;
  
  const script = document.createElement('script');
  script.type = 'module';
  script.textContent = `
    import * as Transformers from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/transformers.min.js';
    window.Transformers = Transformers;
  `;
  document.head.appendChild(script);
  
  await new Promise((resolve) => {
    const check = setInterval(() => {
      if (window.Transformers) {
        clearInterval(check);
        resolve();
      }
    }, 100);
  });
  
  return window.Transformers;
}

let pipeline = null;
let currentModelId = null;

async function initPipeline(modelId) {
  const Transformers = await loadTransformers();
  
  if (pipeline && currentModelId === modelId) return pipeline;
  
  pipeline = await Transformers.pipeline('text-generation', modelId, {
    dtype: 'q4',
    device: 'webgpu',
    progress_callback: (p) => {
      if (p.status === 'downloading') {
        console.log(`Downloading ${modelId}: ${Math.round(p.progress * 100)}%`);
      }
    },
  });
  
  currentModelId = modelId;
  return pipeline;
}

async function sendToTransformersJS(messages, provider, systemText) {
  const modelId = provider.model || 'Xenova/Phi-3.5-mini-instruct';
  const pipe = await initPipeline(modelId);
  
  const prompt = formatPrompt(messages, systemText);
  
  const output = await pipe(prompt, {
    max_new_tokens: provider.maxTokens > 0 ? provider.maxTokens : 2048,
    temperature: 0.7,
    top_p: 0.95,
    do_sample: true,
    return_full_text: false,
  });
  
  return output[0]?.generated_text || '';
}

async function streamTransformersJS(messages, provider, systemText, onDelta, signal) {
  const modelId = provider.model || 'Xenova/Phi-3.5-mini-instruct';
  const pipe = await initPipeline(modelId);
  
  const prompt = formatPrompt(messages, systemText);
  
  let fullText = '';
  
  const output = await pipe(prompt, {
    max_new_tokens: provider.maxTokens > 0 ? provider.maxTokens : 2048,
    temperature: 0.7,
    top_p: 0.95,
    do_sample: true,
    return_full_text: false,
    callback_function: (text) => {
      if (signal?.aborted) throw new Error('Aborted');
      fullText = text;
      onDelta(text);
    },
  });
  
  return output[0]?.generated_text || fullText;
}

function formatPrompt(messages, systemText) {
  let prompt = '';
  
  if (systemText) {
    prompt += `<|system|>\n${systemText}\n`;
  }
  
  for (const msg of messages) {
    const role = msg.role === 'assistant' ? 'assistant' : 'user';
    prompt += `<|${role}|>\n${msg.content}\n`;
  }
  
  prompt += '<|assistant|>\n';
  
  return prompt;
}

module.exports = { sendToTransformersJS, streamTransformersJS };