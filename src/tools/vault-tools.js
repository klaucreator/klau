'use strict';

const { ensureFolderExists, applyOrganizeAction } = require('./vault-mutations');
const { searchWeb } = require('./web-search');

// Runs one agent tool call against the vault. Read-only tools (list_files, read_note,
// read_notes, get_note_metadata, search_notes, search_web) always run automatically; mutating
// tools (write_note, append_note, add_tags, move_note, rename_note, create_folder, delete_note)
// are the same regardless of approval state — the Agent view is responsible for gating them
// behind Approve/Skip before calling this.
async function runAgentTool(app, tool, args) {
  switch (tool) {
    case 'list_files': {
      const folder = (args.folder || '').replace(/^\/+|\/+$/g, '');
      const files = app.vault
        .getMarkdownFiles()
        .filter((f) => !folder || f.path.startsWith(folder + '/'))
        .map((f) => f.path);
      const capped = files.slice(0, 300);
      return capped.length === 0
        ? 'No files found.'
        : capped.join('\n') + (files.length > 300 ? `\n...(${files.length} total, truncated)` : '');
    }

    case 'read_note': {
      const file = app.vault.getAbstractFileByPath(args.path);
      if (!file) throw new Error(`File not found: ${args.path}`);
      const content = await app.vault.cachedRead(file);
      const capped = content.slice(0, 4000);
      return capped + (content.length > 4000 ? '\n...(truncated)' : '');
    }

    case 'read_notes': {
      const paths = Array.isArray(args.paths) ? args.paths : [];
      if (paths.length === 0) throw new Error('Missing paths array.');
      const capped = paths.slice(0, 10);
      const parts = [];
      for (const p of capped) {
        const file = app.vault.getAbstractFileByPath(p);
        if (!file) {
          parts.push(`### ${p}\n(not found)`);
          continue;
        }
        const content = await app.vault.cachedRead(file);
        const snippet = content.slice(0, 1500);
        parts.push(`### ${p}\n${snippet}${content.length > 1500 ? '\n...(truncated)' : ''}`);
      }
      if (paths.length > 10) {
        parts.push(`...(${paths.length - 10} more path(s) not read — call read_notes again for the rest)`);
      }
      return parts.join('\n\n');
    }

    case 'get_note_metadata': {
      const path = String(args.path || '');
      if (!path) throw new Error('Missing path.');
      const file = app.vault.getAbstractFileByPath(path);
      if (!file) throw new Error(`File not found: ${path}`);
      const cache = app.metadataCache.getFileCache(file);
      const fm = cache?.frontmatter || {};
      const tags = Array.isArray(fm.tags) ? fm.tags : fm.tags ? [fm.tags] : (cache?.tags?.map((t) => t.tag) || []);
      const { tags: _omit, ...restFrontmatter } = fm;
      const content = await app.vault.cachedRead(file);
      const wordCount = content.trim() ? content.trim().split(/\s+/).length : 0;
      const info = {
        path,
        tags,
        frontmatter: restFrontmatter,
        wordCount,
        sizeBytes: file.stat?.size ?? null,
        created: file.stat?.ctime ? new Date(file.stat.ctime).toISOString() : null,
        modified: file.stat?.mtime ? new Date(file.stat.mtime).toISOString() : null,
      };
      return JSON.stringify(info, null, 2);
    }

    case 'search_notes': {
      const query = (args.query || '').toLowerCase();
      if (!query) throw new Error('Missing query.');
      const files = app.vault.getMarkdownFiles().slice(0, 500);
      const matches = [];
      for (const file of files) {
        if (matches.length >= 20) break;
        const content = await app.vault.cachedRead(file);
        const idx = content.toLowerCase().indexOf(query);
        if (idx !== -1) {
          const start = Math.max(0, idx - 60);
          const snippet = content.slice(start, idx + query.length + 60).replace(/\s+/g, ' ');
          matches.push(`${file.path}: ...${snippet}...`);
        }
      }
      return matches.length === 0 ? 'No matches found.' : matches.join('\n');
    }

    case 'write_note': {
      const path = String(args.path || '');
      if (!path) throw new Error('Missing path.');
      const folder = path.split('/').slice(0, -1).join('/');
      await ensureFolderExists(app, folder);
      const existing = app.vault.getAbstractFileByPath(path);
      if (existing) {
        await app.vault.modify(existing, args.content || '');
        return `Overwrote existing note: ${path}`;
      }
      await app.vault.create(path, args.content || '');
      return `Created note: ${path}`;
    }

    case 'append_note': {
      const path = String(args.path || '');
      if (!path) throw new Error('Missing path.');
      const existing = app.vault.getAbstractFileByPath(path);
      if (existing) {
        const current = await app.vault.read(existing);
        await app.vault.modify(existing, current + '\n' + (args.content || ''));
        return `Appended to: ${path}`;
      }
      const folder = path.split('/').slice(0, -1).join('/');
      await ensureFolderExists(app, folder);
      await app.vault.create(path, args.content || '');
      return `Created note (did not exist yet): ${path}`;
    }

    case 'add_tags':
      await applyOrganizeAction(app, { action: 'add_tags', path: args.path, tags: args.tags || [] });
      return `Added tags [${(args.tags || []).join(', ')}] to ${args.path}`;

    case 'move_note':
      await applyOrganizeAction(app, {
        action: 'move',
        path: args.path,
        newPath: args.newPath,
      });
      return `Moved ${args.path} → ${args.newPath}`;

    case 'rename_note':
      await applyOrganizeAction(app, {
        action: 'rename',
        path: args.path,
        newName: args.newName,
      });
      return `Renamed ${args.path} → ${args.newName}`;

    case 'create_folder':
      await ensureFolderExists(app, String(args.path || ''));
      return `Ensured folder exists: ${args.path}`;

    case 'delete_note': {
      const path = String(args.path || '');
      if (!path) throw new Error('Missing path.');
      const file = app.vault.getAbstractFileByPath(path);
      if (!file) throw new Error(`File not found: ${path}`);
      try {
        await app.vault.trash(file, true); // prefer the OS trash (recoverable)
      } catch (e) {
        await app.vault.trash(file, false); // fall back to Obsidian's own .trash folder
      }
      return `Moved to trash (not permanently deleted): ${path}`;
    }

    case 'search_web':
      return await searchWeb(args.query);

    default:
      throw new Error(`Unknown tool: ${tool}`);
  }
}

module.exports = { runAgentTool };
