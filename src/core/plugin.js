'use strict';

const { Plugin, MarkdownRenderer, Component } = require('obsidian');

const {
  VIEW_TYPE_AI_CHAT,
  VIEW_TYPE_AI_AGENT,
  VIEW_TYPE_AI_VILLAGE,
  DEFAULT_SETTINGS,
  CHAT_NO_TOOLS_SYSTEM_NOTE,
} = require('./constants');

const providers = require('../providers');
const { agentCall, parseAgentResponse } = require('../agents/agent-loop');
const { TEAM_SELECT_SYSTEM_PROMPT, MEETING_ATTENDEES_SYSTEM_PROMPT } = require('../agents/system-prompt');
const { runAgentTool } = require('../tools/vault-tools');
const { applyOrganizeAction } = require('../tools/vault-mutations');
const { requestOrganizePlan } = require('../workflow/organize');
const { VillageStore } = require('../village/village-store');
const { EventBus } = require('./event-bus');
const { MemoryManager } = require('../memory/memory-manager');

const { AIChatView } = require('../ui/chat-view');
const { AgentView } = require('../ui/agent-view');
const { VillageView } = require('../ui/village-view');
const { OrganizeModal } = require('../ui/organize-modal');
const { AIChatSettingTab } = require('../ui/settings-tab');
const { AgentStatusBar } = require('../ui/agent-status-bar');

/**
 * Plugin entry point. Owns settings persistence, view registration/activation, and the
 * plugin-bundled resource resolver (village map / character art) — everything else (provider
 * requests, the agent loop, vault tools, the organize workflow, village state) is delegated to
 * its own module. This class is the wiring, not the logic.
 */
module.exports = class AIChatSidebarPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.eventBus = new EventBus();
    this.memory = new MemoryManager({ shortTermLimit: 50 });

    this.village = new VillageStore(this);
    if (this.settings.villageState) {
      try { this.village.fromJSON(this.settings.villageState); } catch (e) { /* skip corrupted state */ }
    }
    this.village.subscribe(() => this._debouncedSaveVillage());

    try {
      this._pluginDir = this.manifest.dir || `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
      this.villageMapUrl = await this._resolvePluginResource(
        `${this._pluginDir}/village-map.jpg`, 'image/jpeg'
      );
    } catch (e) {
      this.villageMapUrl = '';
      this._pluginDir = '';
    }
    this._spriteUrlCache = new Map();
    this._dataUrlCache = new Map();
    this._villageSaveTimer = null;
    this._markdownComponent = new Component();
    this._audioContext = null;
    this._notificationSound = null;

    this.registerView(VIEW_TYPE_AI_CHAT, (leaf) => new AIChatView(leaf, this));
    this.registerView(VIEW_TYPE_AI_AGENT, (leaf) => new AgentView(leaf, this));
    this.registerView(VIEW_TYPE_AI_VILLAGE, (leaf) => new VillageView(leaf, this));

    this.addRibbonIcon('message-square', 'Open AI Chat', () => {
      this.activateView();
    });

    this.addRibbonIcon('bot', 'Open AI Agent', () => {
      this.activateAgentView();
    });

    this.addRibbonIcon('castle', 'Open AI Village', () => {
      this.activateVillageView();
    });

    this.addCommand({
      id: 'open-ai-chat-sidebar',
      name: 'Open AI chat sidebar',
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: 'open-ai-agent',
      name: 'Open AI agent',
      callback: () => this.activateAgentView(),
    });

    this.addCommand({
      id: 'open-ai-village',
      name: 'Open AI village',
      callback: () => this.activateVillageView(),
    });

    this.addCommand({
      id: 'ai-organize-vault',
      name: 'Organize vault with AI (preview & confirm)',
      callback: () => new OrganizeModal(this.app, this).open(),
    });

    this.addSettingTab(new AIChatSettingTab(this.app, this));

    // Initialize mobile-friendly agent status bar
    this.agentStatusBar = new AgentStatusBar(this);
    const statusBarContainer = this.app.workspace.containerEl.createDiv({ cls: 'ai-agent-status-bar' });
    this.agentStatusBar.create(statusBarContainer);
    this._statusBarContainer = statusBarContainer;
    // Show on mobile by default, or when there are active agents
    if (this.isMobile()) {
      statusBarContainer.addClass('visible');
    }

    // Subscribe to village changes to show/hide status bar
    this._villageStatusSub = this.village.subscribe(() => this.updateStatusBarVisibility());
    this.updateStatusBarVisibility();
  }

  isMobile() {
    return /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
           (navigator.maxTouchPoints && navigator.maxTouchPoints > 1 && /MacIntel/.test(navigator.platform));
  }

  updateStatusBarVisibility() {
    if (!this._statusBarContainer) return;
    const hasActiveAgents = Array.from(this.village.villagers.values()).some(
      v => !v.isSubagent && v.status !== 'idle'
    );
    const shouldShow = this.isMobile() || hasActiveAgents;
    this._statusBarContainer.toggleClass('visible', shouldShow);
  }

  _debouncedSaveVillage() {
    clearTimeout(this._villageSaveTimer);
    this._villageSaveTimer = setTimeout(() => {
      this.settings.villageState = this.village.toJSON();
      this.saveSettings();
    }, 2000);
  }

  // Initialize audio context and load notification sound
  async _initAudio() {
    if (this._audioContext) return;
    try {
      this._audioContext = new (window.AudioContext || window.webkitAudioContext)();
      // Generate a simple chime tone programmatically (no external file needed)
      const sampleRate = this._audioContext.sampleRate;
      const duration = 0.3;
      const samples = Math.floor(sampleRate * duration);
      const buffer = this._audioContext.createBuffer(1, samples, sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < samples; i++) {
        const t = i / sampleRate;
        data[i] = Math.sin(2 * Math.PI * 880 * t) * Math.exp(-t * 15) * 0.3; // A5 note, decay
      }
      this._notificationSound = buffer;
    } catch (e) {
      console.warn('Audio initialization failed:', e);
    }
  }

  // Play notification chime (unlocks audio on first user interaction)
  async playNotificationSound() {
    await this._initAudio();
    if (!this._audioContext || !this._notificationSound) return;
    // Resume context if suspended (mobile requires user interaction)
    if (this._audioContext.state === 'suspended') {
      await this._audioContext.resume();
    }
    const source = this._audioContext.createBufferSource();
    source.buffer = this._notificationSound;
    source.connect(this._audioContext.destination);
    source.start();
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_AI_CHAT);
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_AI_AGENT);
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_AI_VILLAGE);
    if (this.agentStatusBar) {
      this.agentStatusBar.destroy();
    }
    if (this._villageStatusSub) {
      this._villageStatusSub();
    }
    if (this._statusBarContainer) {
      this._statusBarContainer.remove();
    }
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_AI_CHAT)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE_AI_CHAT, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  async activateAgentView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_AI_AGENT)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE_AI_AGENT, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  async activateVillageView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_AI_VILLAGE)[0];
    if (!leaf) {
      leaf = workspace.getLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE_AI_VILLAGE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  // Resolves a plugin-bundled resource (image, etc.) to a loadable URL. Tries the fast
  // getResourcePath path first (works on desktop); if that returns nothing, reads the file
  // as binary and embeds it as a data: URI — slower but works everywhere, including Android
  // where getResourcePath often can't serve files under .obsidian/plugins/.
  async _resolvePluginResource(relativePath, mimeType) {
    try {
      const url = this.app.vault.adapter.getResourcePath(relativePath);
      if (url) return url;
    } catch (e) {}
    const cached = this._dataUrlCache.get(relativePath);
    if (cached) return cached;
    try {
      const data = await this.app.vault.adapter.readBinary(relativePath);
      const bytes = new Uint8Array(data);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      const dataUrl = `data:${mimeType};base64,${btoa(binary)}`;
      this._dataUrlCache.set(relativePath, dataUrl);
      return dataUrl;
    } catch (e) {}
    return '';
  }

  // Character art ships at characters/<SpriteDir>/<direction>.png, direction being one of
  // north/north-east/east/south-east/south/south-west/west/north-west. Returns '' for
  // professions with no art (spriteDir null) so callers fall back to the emoji badge.
  getSpriteUrl(spriteDir, direction) {
    if (!spriteDir || !this._pluginDir) return '';
    const cacheKey = `${spriteDir}/${direction}`;
    let url = this._spriteUrlCache.get(cacheKey);
    if (url === undefined) {
      try {
        url = this.app.vault.adapter.getResourcePath(`${this._pluginDir}/characters/${spriteDir}/${direction}.png`);
      } catch (e) {
        url = '';
      }
      this._spriteUrlCache.set(cacheKey, url);
    }
    return url;
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  getActiveProvider() {
    return providers.resolveActiveProvider(this.settings);
  }

  // --- Chat sidebar: single request/response, no tool-calling loop ---

  async sendMessage(messages) {
    const provider = this.getActiveProvider();
    const systemText = [CHAT_NO_TOOLS_SYSTEM_NOTE, this.settings.systemPrompt].filter(Boolean).join('\n\n');
    return await providers.sendMessage(messages, provider, systemText);
  }

  async sendStreamMessage(messages, onDelta, signal) {
    const provider = this.getActiveProvider();
    const systemText = [CHAT_NO_TOOLS_SYSTEM_NOTE, this.settings.systemPrompt].filter(Boolean).join('\n\n');
    return await providers.streamMessage(messages, provider, systemText, onDelta, signal);
  }

  renderMarkdown(el, markdown) {
    el.empty();
    MarkdownRenderer.render(this.app, markdown, el, '/', this._markdownComponent);
  }

  // --- Organize feature: gather vault info, ask AI for a plan, never execute anything itself ---

  async requestOrganizePlan() {
    return await requestOrganizePlan(this.app, this.settings);
  }

  async applyOrganizeAction(action) {
    return await applyOrganizeAction(this.app, action);
  }

  // --- Agent feature: multi-step tool-using loop. Read-only tools run automatically; ---
  // --- mutating tools pause for approval unless the user has opted into auto-approve. ---

  async agentCall(transcript, roleText, onDelta) {
    return await agentCall(transcript, roleText, onDelta, {
      provider: this.getActiveProvider(),
      extraSystemPrompt: this.settings.systemPrompt,
    });
  }

  // Asks the AI which configured team members (if any) are relevant to this goal, and in
  // what order — replaces manually ticking checkboxes before a run. Returns a subset of
  // `team`, in run order; an empty array means "run solo instead."
  async selectTeamForGoal(goal, team) {
    if (!team || team.length === 0) return [];
    const provider = this.getActiveProvider();
    const roster = team.map((m) => `- ${m.name}: ${m.role || '(no role description)'}`).join('\n');
    const prompt = `Goal: ${goal}\n\nTeam roster:\n${roster}`;
    const raw = await providers.sendMessage([{ role: 'user', content: prompt }], provider, TEAM_SELECT_SYSTEM_PROMPT);
    const parsed = parseAgentResponse(raw);
    const entries = Array.isArray(parsed.members) ? parsed.members : [];
    const byName = new Map(team.map((m) => [m.name.trim().toLowerCase(), m]));
    const selected = [];
    const seen = new Set();
    for (const entry of entries) {
      const isObj = entry && typeof entry === 'object';
      const rawName = isObj ? entry.name : entry;
      const note = isObj && typeof entry.note === 'string' ? entry.note.trim() : '';
      const key = String(rawName || '').trim().toLowerCase();
      const member = byName.get(key);
      if (member && !seen.has(key)) {
        seen.add(key);
        // Spread into a fresh object rather than mutating the stored team-member settings —
        // `note` is per-run flavor text, not something that should end up persisted to disk.
        selected.push({ ...member, note });
      }
    }
    return selected;
  }

  // In-character as the Mayor: given the goal and the team members who finished their part
  // (with a short summary of what each reported), decides who actually needs to attend the
  // Town Hall wrap-up meeting — could be everyone, or just some. Falls back to inviting
  // everyone if there's nothing meaningful to decide, or if the call fails, so a meeting
  // never silently loses an attendee it shouldn't have dropped.
  async selectMeetingAttendees(goal, finishedMembers) {
    if (!finishedMembers || finishedMembers.length <= 1) return finishedMembers || [];
    try {
      const provider = this.getActiveProvider();
      const roster = finishedMembers
        .map((m) => `- ${m.name}: ${m.report ? m.report.slice(0, 160) : '(no report)'}`)
        .join('\n');
      const prompt = `Goal: ${goal}\n\nTeam members who finished their part:\n${roster}`;
      const raw = await providers.sendMessage(
        [{ role: 'user', content: prompt }],
        provider,
        MEETING_ATTENDEES_SYSTEM_PROMPT
      );
      const parsed = parseAgentResponse(raw);
      const names = Array.isArray(parsed.attendees) ? parsed.attendees : [];
      const byName = new Map(finishedMembers.map((m) => [m.name.trim().toLowerCase(), m]));
      const attendees = [];
      const seen = new Set();
      for (const name of names) {
        const key = String(name || '').trim().toLowerCase();
        const member = byName.get(key);
        if (member && !seen.has(key)) {
          seen.add(key);
          attendees.push(member);
        }
      }
      return attendees.length > 0 ? attendees : finishedMembers;
    } catch (err) {
      // If the Mayor's call fails for any reason, default to inviting everyone rather than
      // silently leaving someone's finished work out of the meeting.
      return finishedMembers;
    }
  }

  parseAgentResponse(raw) {
    return parseAgentResponse(raw);
  }

  async runAgentTool(tool, args) {
    return await runAgentTool(this.app, tool, args);
  }
};
