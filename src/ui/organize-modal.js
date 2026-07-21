'use strict';

const { Modal, Notice } = require('obsidian');

class OrganizeModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.actions = [];
    this.checkedState = [];
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('ai-organize-modal');
    contentEl.createEl('h2', { text: 'Organize vault with AI' });
    this.statusEl = contentEl.createEl('p', {
      text: 'Scanning vault and asking the AI for suggestions...',
      cls: 'setting-item-description',
    });
    this.listEl = contentEl.createDiv({ cls: 'ai-organize-list' });
    this.footerEl = contentEl.createDiv({ cls: 'ai-organize-footer' });

    this.loadPlan();
  }

  async loadPlan() {
    const village = this.plugin.village;
    village.ensure('librarian', 'librarian', 'Librarian');
    village.setStatus('librarian', 'working', { taskText: 'Scanning the vault...' });

    try {
      const { actions, truncated, total, scannedCount } = await this.plugin.requestOrganizePlan();
      this.actions = actions;
      this.checkedState = actions.map(() => true);

      if (actions.length === 0) {
        this.statusEl.setText(
          total === 0
            ? 'No markdown files found in the vault.'
            : "The AI didn't propose any changes."
        );
        village.setStatus('librarian', 'finished', { taskText: 'Nothing to reorganize' });
        village.say('librarian', 'Everything already has its place.');
        return;
      }

      this.statusEl.setText(
        `Proposed ${actions.length} change(s) below. Nothing has been applied yet — ` +
          `review, uncheck anything you don't want, then click Apply.` +
          (truncated ? ` (Only ${scannedCount} of ${total} files were scanned.)` : '')
      );
      village.setStatus('librarian', 'reviewing', { taskText: `${actions.length} change(s) proposed` });
      village.say('librarian', `I've drawn up ${actions.length} proposed change(s) — awaiting your review.`);
      this.renderActions();
      this.renderFooter();
    } catch (err) {
      this.statusEl.setText(`⚠️ ${err.message}`);
      village.setStatus('librarian', 'error', { taskText: err.message.slice(0, 80) });
      village.say('librarian', `Couldn't finish the survey — ${err.message.slice(0, 70)}`);
    }
  }

  renderActions() {
    this.listEl.empty();
    this.actions.forEach((action, i) => {
      const row = this.listEl.createDiv({ cls: 'ai-organize-row' });
      const checkbox = row.createEl('input', { type: 'checkbox' });
      checkbox.checked = this.checkedState[i];
      checkbox.addEventListener('change', (e) => {
        this.checkedState[i] = e.target.checked;
      });

      const desc = row.createDiv({ cls: 'ai-organize-desc' });
      desc.createDiv({ cls: 'ai-organize-action-label', text: this.describeAction(action) });
      if (action.reason) {
        desc.createDiv({ cls: 'ai-organize-reason', text: action.reason });
      }
    });
  }

  describeAction(action) {
    if (action.action === 'move') return `Move "${action.path}" → "${action.newPath}"`;
    if (action.action === 'rename') return `Rename "${action.path}" → "${action.newName}"`;
    if (action.action === 'add_tags')
      return `Add tags to "${action.path}": ${(action.tags || []).join(', ')}`;
    return `${action.action} on "${action.path}"`;
  }

  renderFooter() {
    this.footerEl.empty();

    const selectAllBtn = this.footerEl.createEl('button', { text: 'Select all' });
    selectAllBtn.addEventListener('click', () => {
      this.checkedState = this.checkedState.map(() => true);
      this.renderActions();
    });

    const selectNoneBtn = this.footerEl.createEl('button', { text: 'Select none' });
    selectNoneBtn.addEventListener('click', () => {
      this.checkedState = this.checkedState.map(() => false);
      this.renderActions();
    });

    const applyBtn = this.footerEl.createEl('button', {
      text: 'Apply selected',
      cls: 'mod-cta',
    });
    applyBtn.addEventListener('click', () => this.applySelected(applyBtn));
  }

  async applySelected(applyBtn) {
    applyBtn.disabled = true;
    const village = this.plugin.village;
    const toApply = this.actions.filter((_, i) => this.checkedState[i]);
    if (toApply.length === 0) {
      new Notice('Nothing selected.');
      applyBtn.disabled = false;
      return;
    }

    village.setStatus('librarian', 'working', { taskText: `Applying ${toApply.length} change(s)...` });

    let succeeded = 0;
    const errors = [];
    for (const action of toApply) {
      try {
        await this.plugin.applyOrganizeAction(action);
        succeeded++;
      } catch (err) {
        errors.push(`${this.describeAction(action)}: ${err.message}`);
      }
    }

    this.statusEl.setText(
      `Applied ${succeeded}/${toApply.length} change(s).` +
        (errors.length ? ` ${errors.length} failed — see notice.` : '')
    );
    new Notice(`AI organize: applied ${succeeded}/${toApply.length} change(s).`);
    if (errors.length) {
      new Notice(`Some changes failed:\n${errors.join('\n')}`);
    }
    if (errors.length > 0 && succeeded === 0) {
      village.setStatus('librarian', 'error', { taskText: errors[0].slice(0, 80) });
    } else {
      village.setStatus('librarian', 'finished', { taskText: `Filed ${succeeded} change(s)` });
      village.say('librarian', `Filed ${succeeded}/${toApply.length} change(s) into the vault.`);
    }
    this.listEl.empty();
    this.footerEl.empty();
  }

  onClose() {
    this.contentEl.empty();
  }
}

module.exports = { OrganizeModal };
