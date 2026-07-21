'use strict';

// Shared SSE reader: consumes a "data: {...}\n\n"-framed stream, applies applyEvent to fold
// each parsed event into the running text, and calls onDelta with the running text after
// every event so callers can show live progress. Malformed/partial lines are skipped rather
// than failing the whole stream.
async function readSse(bodyStream, applyEvent, onDelta) {
  const reader = bodyStream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const dataStr = trimmed.slice(5).trim();
      if (!dataStr || dataStr === '[DONE]') continue;
      try {
        const evt = JSON.parse(dataStr);
        const updated = applyEvent(evt, full);
        if (updated !== full) {
          full = updated;
          if (onDelta) onDelta(full);
        }
      } catch (e) {
        // Ignore lines that aren't complete JSON yet — SSE framing guarantees a later
        // line will complete the event.
      }
    }
  }
  return full;
}

module.exports = { readSse };
