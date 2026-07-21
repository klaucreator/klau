'use strict';

const providers = require('../providers');
const { parseLenientJson } = require('../core/json-utils');

async function gatherVaultSummary(app, maxFiles) {
  const files = app.vault.getMarkdownFiles();
  const max = maxFiles || 150;
  const truncated = files.length > max;
  const subset = files.slice(0, max);

  const summary = [];
  for (const file of subset) {
    const cache = app.metadataCache.getFileCache(file);
    const tags = cache?.frontmatter?.tags || cache?.tags?.map((t) => t.tag) || [];
    let preview = '';
    try {
      const content = await app.vault.cachedRead(file);
      preview = content.replace(/\s+/g, ' ').trim().slice(0, 200);
    } catch (e) {
      preview = '';
    }
    summary.push({ path: file.path, tags, preview });
  }
  return { summary, truncated, total: files.length };
}

function buildOrganizePrompt(summary) {
  return [
    'You are helping organize an Obsidian vault. Below is a JSON list of existing markdown files,',
    'each with its current path, any tags, and a short content preview.',
    '',
    'Propose an organization plan as a JSON array of action objects. Allowed action types:',
    '- {"action":"move","path":"<existing path>","newPath":"<new folder path ending in the same filename>","reason":"..."}',
    '- {"action":"rename","path":"<existing path>","newName":"<new filename ending in .md, no folder>","reason":"..."}',
    '- {"action":"add_tags","path":"<existing path>","tags":["tag1","tag2"],"reason":"..."}',
    '',
    'Rules:',
    '- Only reference paths that appear in the list below. Never invent files.',
    '- Never propose deleting anything.',
    '- Prefer a small number of clear, sensibly-named folders over many tiny ones.',
    '- Keep "reason" to one short sentence.',
    '- Respond with ONLY the JSON array, no prose, no code fences, no explanation.',
    '',
    'Files:',
    JSON.stringify(summary, null, 0),
  ].join('\n');
}

// Scans the vault, asks the active provider for a plan, and returns only the actions that
// reference files actually shown to the model and that use a known action type. Applying the
// plan is a separate, explicit step (see tools/vault-mutations.js) — this function never
// changes anything.
async function requestOrganizePlan(app, settings) {
  const provider = providers.resolveActiveProvider(settings);
  providers.assertUsableProvider(provider);

  const { summary, truncated, total } = await gatherVaultSummary(app, settings.organizeMaxFiles);
  if (summary.length === 0) {
    return { actions: [], truncated, total, scannedCount: 0 };
  }
  const prompt = buildOrganizePrompt(summary);
  const messages = [{ role: 'user', content: prompt }];

  // Matches the original behavior of sending the user's configured system prompt (if any)
  // along with the organize request.
  const raw = await providers.sendMessage(messages, provider, settings.systemPrompt);

  let actions;
  try {
    actions = parseLenientJson(raw);
    if (!Array.isArray(actions)) throw new Error('Response was not a JSON array.');
  } catch (e) {
    throw new Error(`Could not parse the AI's plan as JSON. Raw response:\n\n${raw}`);
  }

  // Only keep actions referencing files we actually sent, and only known action types.
  const knownPaths = new Set(summary.map((s) => s.path));
  const validActions = actions.filter(
    (a) =>
      a &&
      typeof a.path === 'string' &&
      knownPaths.has(a.path) &&
      ['move', 'rename', 'add_tags'].includes(a.action)
  );

  return { actions: validActions, truncated, total, scannedCount: summary.length };
}

module.exports = { gatherVaultSummary, buildOrganizePrompt, requestOrganizePlan };
