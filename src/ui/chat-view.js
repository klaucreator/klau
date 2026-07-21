'use strict';

const { ItemView, Notice } = require('obsidian');
const { VIEW_TYPE_AI_CHAT } = require('../core/constants');

class AIChatView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.history = [];
  }

  getViewType() {
    return VIEW_TYPE_AI_CHAT;
  }
  getDisplayText() {
    return 'AI Chat';
  }
  getIcon() {
    return 'message-square';
  }

  async onOpen() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass('ai-chat-sidebar-container');

    const header = container.createDiv({ cls: 'ai-chat-header' });

    this.providerSelect = header.createEl('select', { cls: 'ai-chat-provider-select' });
    this.refreshProviderOptions();
    this.providerSelect.addEventListener('change', async (e) => {
      this.plugin.settings.activeProviderId = e.target.value;
      await this.plugin.saveSettings();
    });

    const includeLabel = header.createEl('label', { cls: 'ai-chat-include-label' });
    this.includeCheckbox = includeLabel.createEl('input', { type: 'checkbox' });
    this.includeCheckbox.checked = this.plugin.settings.includeActiveNote;
    includeLabel.createSpan({ text: ' Include current note' });
    this.includeCheckbox.addEventListener('change', async (e) => {
      this.plugin.settings.includeActiveNote = e.target.checked;
      await this.plugin.saveSettings();
    });

    const clearBtn = header.createEl('button', { text: 'Clear', cls: 'ai-chat-clear-btn' });
    clearBtn.addEventListener('click', () => {
      this.history = [];
      this.messagesEl.empty();
    });

    this.messagesEl = container.createDiv({ cls: 'ai-chat-messages' });

    const inputArea = container.createDiv({ cls: 'ai-chat-input-area' });
    this.inputEl = inputArea.createEl('textarea', {
      cls: 'ai-chat-input',
      attr: { placeholder: 'Ask anything... (Enter to send, Shift+Enter for newline)', rows: '3' },
    });
    this.sendBtn = inputArea.createEl('button', { text: 'Send', cls: 'ai-chat-send-btn mod-cta' });

    this.sendBtn.addEventListener('click', () => this.handleSend());
    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.handleSend();
      }
    });
  }

  refreshProviderOptions() {
    this.providerSelect.empty();
    for (const p of this.plugin.settings.providers) {
      const opt = this.providerSelect.createEl('option', { text: p.name, value: p.id });
      if (p.id === this.plugin.settings.activeProviderId) opt.selected = true;
    }
  }

  async handleSend() {
    const text = this.inputEl.value.trim();
    if (!text) return;

    let userContent = text;
    if (this.includeCheckbox.checked) {
      const file = this.app.workspace.getActiveFile();
      if (file) {
        const noteText = await this.app.vault.read(file);
        userContent = `Context from current note "${file.basename}":\n\n${noteText}\n\n---\n\nQuestion: ${text}`;
      }
    }

    this.history.push({ role: 'user', content: userContent });
    this.renderMessage('user', text);
    this.inputEl.value = '';
    this.sendBtn.disabled = true;

    const thinkingEl = this.renderMessage('assistant', 'Thinking...');

    const village = this.plugin.village;
    village.ensure('innkeeper', 'innkeeper', 'Innkeeper');
    village.setStatus('innkeeper', 'working', { taskText: text.slice(0, 80) });

    try {
      const reply = await this.plugin.sendMessage(
        this.history.map((h) => ({ role: h.role, content: h.content }))
      );
      thinkingEl.remove();
      this.renderMessage('assistant', reply);
      this.history.push({ role: 'assistant', content: reply });
      village.setStatus('innkeeper', 'finished', { taskText: 'Answered a question' });
      village.say('innkeeper', reply.slice(0, 90));
    } catch (err) {
      thinkingEl.remove();
      this.renderMessage('assistant', `⚠️ Error: ${err.message}`);
      new Notice(`AI Chat error: ${err.message}`);
      village.setStatus('innkeeper', 'error', { taskText: err.message.slice(0, 80) });
      village.say('innkeeper', `Ink spilled — ${err.message.slice(0, 70)}`);
    } finally {
      this.sendBtn.disabled = false;
    }
  }

  renderMessage(role, text) {
    const msgEl = this.messagesEl.createDiv({ cls: `ai-chat-message ai-chat-${role}` });
    msgEl.createDiv({
      cls: 'ai-chat-role',
      text: role === 'user' ? 'You' : this.plugin.getActiveProvider()?.name || 'AI',
    });
    const bodyEl = msgEl.createDiv({ cls: 'ai-chat-body' });
    bodyEl.setText(text);
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    return msgEl;
  }

  async onClose() {}
}

module.exports = { AIChatView };
