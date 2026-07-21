'use strict';

// Tools that change vault content — these pause for Approve/Skip in the Agent view unless
// auto-approve is on, unlike read-only tools which always run automatically.
const MUTATING_TOOLS = new Set([
  'write_note',
  'append_note',
  'add_tags',
  'move_note',
  'rename_note',
  'create_folder',
  'delete_note',
]);

// Which single arg field, if any, is user-editable in the approval prompt for a mutating
// tool. The value shown/edited is a plain string (tags are joined with ", " for editing
// and split back apart on approve). Tools not listed here show read-only args as before.
const AGENT_EDITABLE_FIELDS = {
  write_note: 'content',
  append_note: 'content',
  add_tags: 'tags',
  move_note: 'newPath',
  rename_note: 'newName',
  create_folder: 'path',
};

module.exports = { MUTATING_TOOLS, AGENT_EDITABLE_FIELDS };
