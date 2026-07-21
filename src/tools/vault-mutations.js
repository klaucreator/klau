'use strict';

async function ensureFolderExists(app, folderPath) {
  if (!folderPath || folderPath === '/') return;
  const existing = app.vault.getAbstractFileByPath(folderPath);
  if (existing) return;
  const parts = folderPath.split('/').filter(Boolean);
  let current = '';
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(current)) {
      try {
        await app.vault.createFolder(current);
      } catch (e) {
        // Folder may already exist due to a race; ignore.
      }
    }
  }
}

// Applies one action produced by the Organize plan (move / rename / add_tags). Also reused
// directly by the agent's add_tags / move_note / rename_note tools so both features share one
// code path for actually touching the vault.
async function applyOrganizeAction(app, action) {
  const file = app.vault.getAbstractFileByPath(action.path);
  if (!file) throw new Error(`File no longer exists: ${action.path}`);

  if (action.action === 'move') {
    const newPath = String(action.newPath || '').replace(/^\/+/, '');
    if (!newPath) throw new Error('Missing newPath.');
    const folder = newPath.split('/').slice(0, -1).join('/');
    await ensureFolderExists(app, folder);
    await app.fileManager.renameFile(file, newPath);
  } else if (action.action === 'rename') {
    const newName = String(action.newName || '').replace(/^\/+/, '');
    if (!newName) throw new Error('Missing newName.');
    const folder = action.path.split('/').slice(0, -1).join('/');
    const newPath = folder ? `${folder}/${newName}` : newName;
    await app.fileManager.renameFile(file, newPath);
  } else if (action.action === 'add_tags') {
    const tags = Array.isArray(action.tags) ? action.tags : [];
    if (tags.length === 0) return;
    await app.fileManager.processFrontMatter(file, (fm) => {
      const existing = Array.isArray(fm.tags) ? fm.tags : fm.tags ? [fm.tags] : [];
      fm.tags = Array.from(new Set([...existing, ...tags]));
    });
  } else {
    throw new Error(`Unknown action type: ${action.action}`);
  }
}

module.exports = { ensureFolderExists, applyOrganizeAction };
