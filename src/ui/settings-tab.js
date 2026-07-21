'use strict';

const { PluginSettingTab, Setting } = require('obsidian');
const { OrganizeModal } = require('./organize-modal');

class AIChatSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'AI Chat Sidebar Settings' });

    containerEl.createEl('p', {
      text:
        'Authentication currently uses API keys, pasted in below. OAuth-style account login is planned for a future version and will sit alongside key-based auth, not replace it.',
      cls: 'setting-item-description',
    });

    new Setting(containerEl)
      .setName('Active provider')
      .setDesc('Which provider the chat sidebar sends messages to.')
      .addDropdown((drop) => {
        for (const p of this.plugin.settings.providers) {
          drop.addOption(p.id, p.name);
        }
        drop.setValue(this.plugin.settings.activeProviderId);
        drop.onChange(async (value) => {
          this.plugin.settings.activeProviderId = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('System prompt')
      .setDesc('Optional instruction sent with every conversation.')
      .addTextArea((text) => {
        text.setValue(this.plugin.settings.systemPrompt);
        text.onChange(async (value) => {
          this.plugin.settings.systemPrompt = value;
          await this.plugin.saveSettings();
        });
      });

    containerEl.createEl('h3', { text: 'AI Village' });
    containerEl.createEl('p', {
      text:
        'Every AI villager — the chat sidebar as the Innkeeper, the Organize command as the ' +
        'Librarian, and every solo or team Agent (a solo Agent is the Mayor; team members map ' +
        'onto the rest of the 19-villager roster) — shows up here as a character going about a ' +
        'medieval settlement. It only reflects activity from the other three features; it never ' +
        'calls an AI provider itself.',
      cls: 'setting-item-description',
    });
    new Setting(containerEl).addButton((btn) => {
      btn.setButtonText('Open AI village').onClick(() => {
        this.plugin.activateVillageView();
      });
    });

    new Setting(containerEl)
      .setName('Notification sound')
      .setDesc('Play a chime when an agent finishes a task or needs approval. On mobile, tap "Test Sound" first to unlock audio.')
      .addButton((btn) => {
        btn.setButtonText('🔊 Test Sound').onClick(() => {
          this.plugin.playNotificationSound();
        });
      });

    new Setting(containerEl)
      .setName('Mobile mode')
      .setDesc('Reduces animations and lowers refresh rate for better battery life on Android/iOS.')
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.mobileMode || false);
        toggle.onChange(async (value) => {
          this.plugin.settings.mobileMode = value;
          await this.plugin.saveSettings();
          if (this.plugin.villageView) {
            this.plugin.villageView.mobileMode = value;
            this.plugin.villageView.applyMobileMode();
            this.plugin.villageView.restartGameLoop();
          }
        });
      });

    containerEl.createEl('h3', { text: 'AI Agent' });
    containerEl.createEl('p', {
      text:
        'The agent works through multi-step goals on its own — reading, searching, writing, ' +
        'tagging, moving, renaming, deleting — but by default it pauses and waits for your ' +
        'approval before any actual file change, and you can edit the details (new content, tags, ' +
        'path) right in the approval prompt before confirming. Deleting only ever moves a note to ' +
        'the trash, never a permanent delete.',
      cls: 'setting-item-description',
    });

    new Setting(containerEl)
      .setName('Max steps per run')
      .setDesc('Safety limit on how many tool calls the agent can make for one goal. Set to -1 for unlimited.')
      .addText((text) => {
        text.setValue(String(this.plugin.settings.agentMaxSteps));
        text.onChange(async (value) => {
          const n = parseInt(value, 10);
          if (!isNaN(n) && n >= -1) {
            this.plugin.settings.agentMaxSteps = n;
            await this.plugin.saveSettings();
          }
        });
      });

    new Setting(containerEl)
      .setName('Auto-approve file changes')
      .setDesc(
        'OFF (default): the agent pauses for your Approve/Skip before writing, tagging, moving, ' +
          'or renaming anything. ON: it applies those changes immediately without asking — only ' +
          'enable this if you trust it and have backups.'
      )
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.agentAutoApprove);
        toggle.onChange(async (value) => {
          this.plugin.settings.agentAutoApprove = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl).addButton((btn) => {
      btn.setButtonText('Open AI agent').onClick(() => {
        this.plugin.activateAgentView();
      });
    });

    containerEl.createEl('h4', { text: 'Agent team (optional)' });
    containerEl.createEl('p', {
      text:
        'Define reusable roles (e.g. "Researcher", "Writer", "Organizer"). For every goal you run ' +
        'in the Agent panel, the Mayor automatically decides which of these roles (if any) are ' +
        'needed, and in what order — no manual selection required. Leave this list empty to just ' +
        'run a single default agent, as before.',
      cls: 'setting-item-description',
    });

    const team = this.plugin.settings.agentTeam || [];
    for (const member of team) {
      this.renderTeamMemberSettings(containerEl, member);
    }

    new Setting(containerEl).addButton((btn) => {
      btn.setButtonText('Add team role').onClick(async () => {
        const id = 'role-' + Date.now();
        this.plugin.settings.agentTeam.push({ id, name: 'New role', role: '' });
        await this.plugin.saveSettings();
        this.display();
      });
    });

    containerEl.createEl('h3', { text: 'Organize with AI' });
    containerEl.createEl('p', {
      text:
        'The AI proposes a plan (move / rename / add tags) as a preview — nothing changes until ' +
        'you review it and click Apply. It never deletes files.',
      cls: 'setting-item-description',
    });

    new Setting(containerEl)
      .setName('Max files to scan')
      .setDesc('Limits how many notes are sent to the AI in one organize request.')
      .addText((text) => {
        text.setValue(String(this.plugin.settings.organizeMaxFiles));
        text.onChange(async (value) => {
          const n = parseInt(value, 10);
          if (!isNaN(n) && n > 0) {
            this.plugin.settings.organizeMaxFiles = n;
            await this.plugin.saveSettings();
          }
        });
      });

    new Setting(containerEl).addButton((btn) => {
      btn.setButtonText('Open organize preview').onClick(() => {
        new OrganizeModal(this.app, this.plugin).open();
      });
    });

    containerEl.createEl('h3', { text: 'Providers' });

    for (const provider of this.plugin.settings.providers) {
      this.renderProviderSettings(containerEl, provider);
    }

    new Setting(containerEl).addButton((btn) => {
      btn.setButtonText('Add provider').onClick(async () => {
        const id = 'provider-' + Date.now();
        this.plugin.settings.providers.push({
          id,
          name: 'Ollama (local)',
          type: 'self-hosted',
          apiKey: '',
          baseUrl: 'http://localhost:11434/v1',
          model: 'llama3.1',
        });
        await this.plugin.saveSettings();
        this.display();
      });
    });

    new Setting(containerEl).addButton((btn) => {
      btn.setButtonText('Add LM Studio').onClick(async () => {
        const id = 'provider-' + Date.now();
        this.plugin.settings.providers.push({
          id,
          name: 'LM Studio (local)',
          type: 'lmstudio',
          apiKey: '',
          baseUrl: 'http://localhost:1234/v1',
          model: 'local-model',
        });
        await this.plugin.saveSettings();
        this.display();
      });
    });

    new Setting(containerEl).addButton((btn) => {
      btn.setButtonText('Add ZeroLLM').onClick(async () => {
        const id = 'provider-' + Date.now();
        this.plugin.settings.providers.push({
          id,
          name: 'ZeroLLM (local)',
          type: 'zerollm',
          apiKey: '',
          baseUrl: 'http://localhost:8000/v1',
          model: 'qwen2.5-7b',
        });
        await this.plugin.saveSettings();
        this.display();
      });
    });
  }

  renderTeamMemberSettings(containerEl, member) {
    const box = containerEl.createDiv({ cls: 'ai-chat-provider-box' });

    new Setting(box).setName('Role name').addText((text) => {
      text.setValue(member.name);
      text.onChange(async (value) => {
        member.name = value;
        await this.plugin.saveSettings();
      });
    });

    new Setting(box)
      .setName('Role instructions')
      .setDesc('What this team member should focus on / how it should behave.')
      .addTextArea((text) => {
        text.setValue(member.role);
        text.onChange(async (value) => {
          member.role = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(box).addButton((btn) => {
      btn
        .setButtonText('Remove role')
        .setWarning()
        .onClick(async () => {
          this.plugin.settings.agentTeam = this.plugin.settings.agentTeam.filter(
            (m) => m.id !== member.id
          );
          await this.plugin.saveSettings();
          this.display();
        });
    });
  }

  renderProviderSettings(containerEl, provider) {
    const box = containerEl.createDiv({ cls: 'ai-chat-provider-box' });
    box.createEl('h4', { text: provider.name });

    new Setting(box).setName('Name').addText((text) => {
      text.setValue(provider.name);
      text.onChange(async (value) => {
        provider.name = value;
        await this.plugin.saveSettings();
      });
    });

    new Setting(box).setName('Type').addDropdown((drop) => {
      drop.addOption('anthropic', 'Claude (Anthropic API)');
      drop.addOption('openai-compatible', 'OpenAI-compatible endpoint');
      drop.addOption('self-hosted', 'Ollama (http://localhost:11434/v1)');
      drop.addOption('lmstudio', 'LM Studio (http://localhost:1234/v1)');
      drop.addOption('zerollm', 'ZeroLLM (http://localhost:8000/v1)');
      drop.addOption('tgi', 'Text-Generation-Inference (http://localhost:8080/v1)');
      drop.addOption('llamacpp', 'llama.cpp server (http://localhost:8080/v1)');
      drop.setValue(provider.type);
      drop.onChange(async (value) => {
        provider.type = value;
        if (value === 'self-hosted' && !provider.baseUrl) provider.baseUrl = 'http://localhost:11434/v1';
        if (value === 'lmstudio' && !provider.baseUrl) provider.baseUrl = 'http://localhost:1234/v1';
        if (value === 'zerollm' && !provider.baseUrl) provider.baseUrl = 'http://localhost:8000/v1';
        if (value === 'tgi' && !provider.baseUrl) provider.baseUrl = 'http://localhost:8080/v1';
        if (value === 'llamacpp' && !provider.baseUrl) provider.baseUrl = 'http://localhost:8080/v1';
        await this.plugin.saveSettings();
        this.display();
      });
    });

    const apiKeySetting = new Setting(box).setName('API key').addText((text) => {
      text.inputEl.type = 'password';
      text.setValue(provider.apiKey);
      text.onChange(async (value) => {
        provider.apiKey = value;
        await this.plugin.saveSettings();
      });
    });
    if (provider.type === 'self-hosted') {
      apiKeySetting.setDesc('Optional for local models (Ollama, LM Studio, etc.)');
      apiKeySetting.settingEl.style.opacity = '0.6';
    } else {
      apiKeySetting.settingEl.style.opacity = '1';
    }

    this.renderSavedApiKeys(box, provider);

    new Setting(box)
      .setName('Base URL')
      .setDesc(
        provider.type === 'anthropic'
          ? 'Usually https://api.anthropic.com'
          : provider.type === 'self-hosted'
            ? 'Ollama: http://localhost:11434/v1'
            : provider.type === 'lmstudio'
              ? 'LM Studio: http://localhost:1234/v1'
              : provider.type === 'zerollm'
                ? 'ZeroLLM: http://localhost:8000/v1'
                : provider.type === 'tgi'
                  ? 'TGI: http://localhost:8080/v1'
                  : provider.type === 'llamacpp'
                    ? 'llama.cpp: http://localhost:8080/v1'
                    : 'e.g. https://api.openai.com/v1, or your self-hosted / local endpoint'
      )
      .addText((text) => {
        text.setValue(provider.baseUrl);
        text.onChange(async (value) => {
          provider.baseUrl = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(box).setName('Model').addText((text) => {
      text.setValue(provider.model);
      text.onChange(async (value) => {
        provider.model = value;
        await this.plugin.saveSettings();
      });
    });

    new Setting(box)
      .setName('Max output tokens')
      .setDesc('Maximum tokens per response. Set to -1 for unlimited. Default: -1.')
      .addText((text) => {
        text.setValue(String(provider.maxTokens || -1));
        text.onChange(async (value) => {
          const n = parseInt(value, 10);
          if (!isNaN(n) && n >= -1) {
            provider.maxTokens = n;
            await this.plugin.saveSettings();
          }
        });
      });

    new Setting(box)
      .setName('Request timeout (ms)')
      .setDesc('Timeout in milliseconds. Default: 120000 (2 min).')
      .addText((text) => {
        text.setValue(String(provider.timeoutMs || 120000));
        text.onChange(async (value) => {
          const n = parseInt(value, 10);
          if (!isNaN(n) && n > 0) {
            provider.timeoutMs = n;
            await this.plugin.saveSettings();
          }
        });
      });

    if (this.plugin.settings.providers.length > 1) {
      new Setting(box).addButton((btn) => {
        btn
          .setButtonText('Remove provider')
          .setWarning()
          .onClick(async () => {
            this.plugin.settings.providers = this.plugin.settings.providers.filter(
              (p) => p.id !== provider.id
            );
            if (this.plugin.settings.activeProviderId === provider.id) {
              this.plugin.settings.activeProviderId = this.plugin.settings.providers[0]?.id;
            }
            await this.plugin.saveSettings();
            this.display();
          });
      });
    }
  }

  // Lets a single provider entry (same type/base URL/model) hold several named API keys and
  // switch which one is active, instead of needing a whole separate provider per key. The
  // provider's `apiKey` field above is always what's actually used for requests — this is
  // just a quick way to stash alternates and swap one in. Each saved key is auto-labeled after
  // the provider's current Name (deduped with a counter if that name's already taken), so there's
  // no separate label field to fill in.
  renderSavedApiKeys(box, provider) {
    if (!provider.savedApiKeys) provider.savedApiKeys = [];

    const keysBox = box.createDiv({ cls: 'ai-chat-provider-keys-box' });
    keysBox.createDiv({
      cls: 'ai-agent-team-label',
      text: 'Saved API keys — stash alternates here and switch which one is active without touching type/URL/model.',
    });

    if (provider.savedApiKeys.length > 0) {
      const activeSaved = provider.savedApiKeys.find((s) => s.apiKey === provider.apiKey);
      const switchSetting = new Setting(keysBox)
        .setName('Active key')
        .setDesc(activeSaved ? `Currently using "${activeSaved.label}".` : 'Currently using the key typed above.')
        .addDropdown((drop) => {
          drop.addOption('', '— choose a saved key —');
          for (const saved of provider.savedApiKeys) {
            drop.addOption(saved.id, saved.label);
          }
          drop.setValue(activeSaved ? activeSaved.id : '');
          drop.onChange(async (value) => {
            const saved = provider.savedApiKeys.find((s) => s.id === value);
            if (!saved) return;
            provider.apiKey = saved.apiKey;
            await this.plugin.saveSettings();
            this.display();
          });
        });

      if (activeSaved) {
        switchSetting.addExtraButton((btn) => {
          btn
            .setIcon('trash')
            .setTooltip(`Remove "${activeSaved.label}"`)
            .onClick(async () => {
              provider.savedApiKeys = provider.savedApiKeys.filter((s) => s.id !== activeSaved.id);
              await this.plugin.saveSettings();
              this.display();
            });
        });
      }
    }

    new Setting(keysBox)
      .setName('Save current key')
      .setDesc(`Stores the API key entered above, labeled "${provider.name}", so you can switch back to it later.`)
      .addButton((btn) => {
        btn.setButtonText('Save').onClick(async () => {
          if (!provider.apiKey) return;
          let label = provider.name;
          let n = 2;
          const existingLabels = new Set(provider.savedApiKeys.map((s) => s.label));
          while (existingLabels.has(label)) {
            label = `${provider.name} (${n})`;
            n++;
          }
          provider.savedApiKeys.push({
            id: 'key-' + Date.now(),
            label,
            apiKey: provider.apiKey,
          });
          await this.plugin.saveSettings();
          this.display();
        });
      });
  }
}

module.exports = { AIChatSettingTab };
