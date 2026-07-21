'use strict';

/**
 * Model responses are supposed to be JSON, but models frequently emit raw, unescaped control
 * characters (actual newlines/tabs, not \n/\t) inside string values — most often when a string
 * field holds multi-line content like a note draft. Strict `JSON.parse` rejects that with
 * "Bad control character in string literal", even though the intent is unambiguous. This walks
 * the text once, tracking whether we're inside a JSON string literal (respecting `\"` escapes),
 * and escapes any raw control character (0x00–0x1F) it finds there before parsing.
 *
 * Only touches bytes that are actually inside a string literal — structural whitespace between
 * tokens is left alone.
 */
function escapeRawControlCharsInStrings(text) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const code = text.charCodeAt(i);

    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        out += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
        out += ch;
        continue;
      }
      if (code <= 0x1f) {
        switch (ch) {
          case '\n': out += '\\n'; break;
          case '\r': out += '\\r'; break;
          case '\t': out += '\\t'; break;
          case '\b': out += '\\b'; break;
          case '\f': out += '\\f'; break;
          default: out += '\\u' + code.toString(16).padStart(4, '0');
        }
        continue;
      }
      out += ch;
      continue;
    }

    if (ch === '"') {
      inString = true;
    }
    out += ch;
  }
  return out;
}

// Strips ``` / ```json code fences a model commonly wraps its JSON in, and trims stray
// surrounding whitespace. Doesn't touch string contents — see escapeRawControlCharsInStrings
// and repairStrayQuotesInStrings for that.
function stripCodeFences(raw) {
  return raw
    .trim()
    .replace(/^```(json)?/i, '')
    .replace(/```$/, '')
    .trim();
}

// Strips ``` / ```json code fences a model commonly wraps its JSON in, trims stray
// surrounding whitespace, and repairs raw control characters inside string literals.
function cleanJsonText(raw) {
  return escapeRawControlCharsInStrings(stripCodeFences(raw));
}

// Models very often echo back a short phrase in "quotes" for emphasis inside a string value
// (e.g. a `"final"` summary mentioning a "suggest a meeting" table) without escaping those
// inner quotes — which strict JSON reads as the string ending right there, corrupting
// everything after it. Walks the text tracking string state like the functions above, but
// for each `"` encountered *inside* a string, looks ahead past whitespace: if the next
// character is a JSON structural character (`,` `}` `]` `:` or end-of-text), it's treated as
// the real closing quote; otherwise it's almost certainly a stray quote inside the content, so
// it gets escaped and the string continues. Not foolproof — a quote immediately followed by
// one of those characters as part of legitimate dialogue could still be misread — but it
// resolves the common case without needing the model to have escaped anything.
function repairStrayQuotesInStrings(text) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (!inString) {
      out += ch;
      if (ch === '"') inString = true;
      continue;
    }

    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      const next = text[j];
      const isStructural = next === undefined || next === ',' || next === '}' || next === ']' || next === ':';
      if (isStructural) {
        inString = false;
        out += ch;
      } else {
        out += '\\"';
      }
      continue;
    }
    out += ch;
  }
  return out;
}

function sliceOutermostBrackets(text) {
  const objStart = text.indexOf('{');
  const objEnd = text.lastIndexOf('}');
  const arrStart = text.indexOf('[');
  const arrEnd = text.lastIndexOf(']');
  const useArray = arrStart !== -1 && (objStart === -1 || arrStart < objStart);
  const start = useArray ? arrStart : objStart;
  const end = useArray ? arrEnd : objEnd;
  return start !== -1 && end !== -1 && end > start ? text.slice(start, end + 1) : null;
}

// Handles a response that got cut off mid-object/array — e.g. the model (or a token-limited
// provider) stopped before emitting the closing brackets, so there's simply no matching `}`/`]`
// for sliceOutermostBrackets to find. Walks the text tracking open string/bracket state; if it
// ends inside an unterminated string, closes the string first, then appends whatever closing
// brackets are still owed, in the right order. Returns null if the text doesn't even start with
// `{` or `[` (nothing sensible to repair).
function closeUnterminatedJson(text) {
  const trimmed = text.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return null;

  const stack = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }

  // Nothing missing — this wasn't actually truncated, so there's nothing for us to add.
  if (!inString && stack.length === 0) return null;

  let repaired = trimmed;
  if (inString) repaired += '"';
  for (let i = stack.length - 1; i >= 0; i--) {
    repaired += stack[i] === '{' ? '}' : ']';
  }
  return repaired;
}

// Parses `raw` as JSON, tolerant of code fences, raw control characters inside strings, stray
// prose before/after the JSON payload, unescaped "quotes" used for emphasis inside a string
// value, and a response that got cut off before its closing brackets. Tries a clean parse
// first, then progressively more aggressive repairs. Truncation repair only recovers what was
// actually emitted — text still missing from the middle can't be reconstructed and will fail
// parsing or produce a partial object, so callers should keep treating a caught error here as
// a real failure.
function parseLenientJson(raw) {
  const fenceStripped = stripCodeFences(raw);
  const cleaned = escapeRawControlCharsInStrings(fenceStripped);
  const stripped = cleaned.replace(/[\x00-\x1f]/g, '');
  const quoteRepaired = escapeRawControlCharsInStrings(repairStrayQuotesInStrings(fenceStripped));
  const attempts = [
    cleaned,
    sliceOutermostBrackets(cleaned),
    stripped,
    sliceOutermostBrackets(stripped),
    closeUnterminatedJson(cleaned),
    closeUnterminatedJson(stripped),
    quoteRepaired,
    sliceOutermostBrackets(quoteRepaired),
    closeUnterminatedJson(quoteRepaired),
  ];
  let lastErr;
  for (const attempt of attempts) {
    if (attempt == null) continue;
    try {
      return JSON.parse(attempt);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

module.exports = {
  escapeRawControlCharsInStrings,
  cleanJsonText,
  stripCodeFences,
  repairStrayQuotesInStrings,
  sliceOutermostBrackets,
  closeUnterminatedJson,
  parseLenientJson,
};
