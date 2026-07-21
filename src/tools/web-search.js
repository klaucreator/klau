'use strict';

const { requestUrl } = require('obsidian');

function stripTags(s) {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .trim();
}

function unwrapDdgUrl(raw) {
  const m = raw.match(/[?&]uddg=([^&]+)/);
  if (!m) return raw.startsWith('//') ? `https:${raw}` : raw;
  try {
    return decodeURIComponent(m[1]);
  } catch (e) {
    return raw;
  }
}

// Free, no API key required: scrape DuckDuckGo's no-JS HTML results page. requestUrl runs
// outside the page's fetch/CORS sandbox, so this works the same on desktop and mobile without
// needing a paid search API or any setup in Settings.
async function searchWeb(query) {
  query = String(query || '').trim();
  if (!query) throw new Error('Missing query.');

  let res;
  try {
    res = await requestUrl({
      url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      method: 'GET',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      },
      throw: false,
    });
  } catch (e) {
    throw new Error(`Web search request failed: ${e.message || e}`);
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Web search failed (HTTP ${res.status}).`);
  }

  const html = res.text || '';
  const links = [];
  const linkRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gis;
  let m;
  while ((m = linkRe.exec(html)) && links.length < 5) {
    links.push({ url: unwrapDdgUrl(m[1]), title: stripTags(m[2]) });
  }
  const snippets = [];
  const snippetRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>(.*?)<\/a>/gis;
  while ((m = snippetRe.exec(html)) && snippets.length < 5) {
    snippets.push(stripTags(m[1]));
  }
  if (links.length === 0) return `No web results found for "${query}".`;
  return links
    .map((l, i) => `${i + 1}. ${l.title}\n${l.url}\n${snippets[i] || ''}`)
    .join('\n\n');
}

module.exports = { searchWeb };
