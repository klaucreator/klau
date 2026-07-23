'use strict';

const { ItemView } = require('obsidian');
const { VIEW_TYPE_AI_VILLAGE } = require('../core/constants');
const { VILLAGE_BUILDINGS, VILLAGE_PROFESSIONS, VILLAGE_SMALLTALK, skillLevel } = require('../village/village-roster');

const VILLAGE_STATUS_PRIORITY = ['error', 'walking', 'working', 'meeting', 'reviewing', 'waiting', 'finished', 'idle'];
const VILLAGE_TICK_MS = 200;
const MOBILE_TICK_MS = 500;

function villageMoodIcon(status, subStatus, extra) {
  if (status === 'error') return '⚠️';
  if (status === 'finished') return '✨';
  if (status === 'walking') return '🚶';
  if (extra === 'sleeping') return '😴';
  if (extra === 'chatting') return '💬';
  if (extra === 'collaborating') return '🤝';
  if (status === 'working' && subStatus === 'reading') return '📖';
  if (status === 'working' && subStatus === 'writing') return '✍️';
  if (status === 'working') return '⚙️';
  if (status === 'meeting') return '🗣️';
  if (status === 'reviewing') return '💭';
  if (status === 'waiting') return '⌛';
  return '🙂';
}

const VILLAGE_SPRITE_DIRS = ['east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north', 'north-east'];
function cartesianToIsoX(x, y) {
  return (x - y) * 0.5 + 50;
}
function cartesianToIsoY(x, y) {
  return (x + y) * 0.25 + 25;
}
function cartesianToIso(x, y) {
  return { x: cartesianToIsoX(x, y), y: cartesianToIsoY(x, y) };
}

function villageDirectionFor(dx, dy) {
  if (Math.abs(dx) < 0.05 && Math.abs(dy) < 0.05) return null;
  const angle = Math.atan2(dy, dx) * (180 / Math.PI);
  const idx = (Math.round(angle / 45) + 8) % 8;
  return VILLAGE_SPRITE_DIRS[idx];
}

class VillageView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.villagerEls = new Map();
    this.villagerFacing = new Map();
    this.buildingEls = new Map();
    this.messengerEls = new Map();
    this.wanderTargets = new Map();
    this.spriteFailed = new Set();
    this.nightMode = 'auto';
    this.unsub = null;
    this.wanderInterval = null;
    this.tickInterval = null;
    this.gameLoop = null;
    this.prevStatus = new Map();
    this.meetingTimers = new Map();
    this.villagerHidden = new Set();
    this.chattingUntil = new Map();
    this.chatCooldown = new Map();
    this.prevPositions = new Map();
    this.diagnosticsOpen = new Set();
    this.mobileMode = this.plugin.settings?.mobileMode || false;
    this.touchStart = null;
    this.scenePan = { x: 0, y: 0 };
    this.isPanning = false;
  }

  getViewType() {
    return VIEW_TYPE_AI_VILLAGE;
  }
  getDisplayText() {
    return 'AI Village';
  }
  getIcon() {
    return 'castle';
  }

  async onOpen() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass('ai-village-container');

    const toolbar = container.createDiv({ cls: 'ai-village-toolbar' });
    toolbar.createDiv({ cls: 'ai-village-title', text: 'The Village' });
    const legend = toolbar.createDiv({ cls: 'ai-village-legend' });
    legend.createSpan({ text: '⚙️ working  🗣️ meeting  💭 reviewing  ⌛ waiting  ✨ finished  ⚠️ error  🚶 walking' });
    this.taskQueueEl = toolbar.createSpan({ cls: 'ai-village-queue-count', text: '' });
    this.diagBtn = toolbar.createEl('button', { cls: 'ai-village-diag-btn', text: '📋 Tools' });
    this.diagBtn.addEventListener('click', () => this.toggleDiagnostics());
    this.nightBtn = toolbar.createEl('button', { cls: 'ai-village-night-toggle', text: '🌓 Auto' });
    this.nightBtn.addEventListener('click', () => {
      this.nightMode = this.nightMode === 'auto' ? 'day' : this.nightMode === 'day' ? 'night' : 'auto';
      this.nightBtn.setText(
        this.nightMode === 'auto' ? '🌓 Auto' : this.nightMode === 'day' ? '☀️ Day' : '🌙 Night'
      );
      this.applyNightMode();
    });

    this.mobileBtn = toolbar.createEl('button', { cls: 'ai-village-mobile-toggle', text: this.mobileMode ? '📱 Mobile' : '🖥️ Desktop' });
    this.mobileBtn.addEventListener('click', async () => {
      this.mobileMode = !this.mobileMode;
      this.mobileBtn.setText(this.mobileMode ? '📱 Mobile' : '🖥️ Desktop');
      this.applyMobileMode();
      this.restartGameLoop();
      // Persist to settings
      if (this.plugin.settings) {
        this.plugin.settings.mobileMode = this.mobileMode;
        await this.plugin.saveSettings();
      }
    });

    const sceneWrap = container.createDiv({ cls: 'ai-village-scene-wrap' });
    this.sceneWrapEl = sceneWrap;
    this.sceneEl = sceneWrap.createDiv({ cls: 'ai-village-scene' });
    if (this.plugin.villageMapUrl) {
      this.sceneEl.style.backgroundImage = `url("${this.plugin.villageMapUrl}")`;
    }
    this.nightOverlayEl = this.sceneEl.createDiv({ cls: 'ai-village-night-overlay' });
    this.spriteLayerEl = this.sceneEl.createDiv({ cls: 'ai-village-sprite-layer' });

    // Diagnostics panel (hidden by default)
    this.diagPanel = container.createDiv({ cls: 'ai-village-diag-panel' });
    this.diagPanel.style.display = 'none';

    for (const [key, b] of Object.entries(VILLAGE_BUILDINGS)) {
      const el = this.spriteLayerEl.createDiv({ cls: 'ai-village-building' });
      const ib = cartesianToIso(b.x, b.y);
      el.style.left = `${ib.x}%`;
      el.style.top = `${ib.y}%`;
      el.createDiv({ cls: 'ai-village-building-glow' });
      el.createDiv({ cls: 'ai-village-building-smoke' });
      const bar = el.createDiv({ cls: 'ai-village-building-bar' });
      bar.createDiv({ cls: 'ai-village-building-bar-fill' });
      el.createDiv({ cls: 'ai-village-building-banner', text: '⚠' });
      el.createDiv({ cls: 'ai-village-building-label', text: b.label });
      this.buildingEls.set(key, el);
    }

    const feedWrap = container.createDiv({ cls: 'ai-village-feed-wrap' });
    const tabRow = feedWrap.createDiv({ cls: 'ai-village-feed-tabs' });
    this.chatterTab = tabRow.createDiv({ cls: 'ai-village-feed-tab is-active', text: 'Chatter' });
    this.consoleTab = tabRow.createDiv({ cls: 'ai-village-feed-tab', text: 'Console' });
    this.subagentTab = tabRow.createDiv({ cls: 'ai-village-feed-tab', text: 'Agents' });
    const panelWrap = feedWrap.createDiv({ cls: 'ai-village-feed-panel-wrap' });
    this.feedEl = panelWrap.createDiv({ cls: 'ai-village-feed' });
    this.consoleEl = panelWrap.createDiv({ cls: 'ai-village-feed ai-village-console' });
    this.consoleEl.style.display = 'none';
    this.subagentEl = panelWrap.createDiv({ cls: 'ai-village-feed ai-village-subagent-list' });
    this.subagentEl.style.display = 'none';

    this.chatterTab.addEventListener('click', () => {
      this.chatterTab.addClass('is-active');
      this.consoleTab.removeClass('is-active');
      this.subagentTab.removeClass('is-active');
      this.feedEl.style.display = 'flex';
      this.consoleEl.style.display = 'none';
      this.subagentEl.style.display = 'none';
    });
    this.consoleTab.addEventListener('click', () => {
      this.consoleTab.addClass('is-active');
      this.chatterTab.removeClass('is-active');
      this.subagentTab.removeClass('is-active');
      this.feedEl.style.display = 'none';
      this.consoleEl.style.display = 'flex';
      this.subagentEl.style.display = 'none';
    });
    this.subagentTab.addEventListener('click', () => {
      this.subagentTab.addClass('is-active');
      this.chatterTab.removeClass('is-active');
      this.consoleTab.removeClass('is-active');
      this.subagentEl.style.display = 'flex';
      this.feedEl.style.display = 'none';
      this.consoleEl.style.display = 'none';
      this.renderSubagentList();
    });

    this.unsub = this.plugin.village.subscribe(() => this.sync());
    this.wanderInterval = window.setInterval(() => this.wanderTick(), 4200);
    this.tickInterval = window.setInterval(() => this.applyNightMode(), 60000);
    this.restartGameLoop();

    this.applyNightMode();
    this.applyMobileMode();
    this.setupTouchPanning();
    this.wanderTick();
    this.sync();
  }

  restartGameLoop() {
    if (this.gameLoop) window.clearInterval(this.gameLoop);
    const tickMs = this.mobileMode ? MOBILE_TICK_MS : VILLAGE_TICK_MS;
    this.gameLoop = window.setInterval(() => this.gameTick(), tickMs);
  }

  applyMobileMode() {
    if (!this.sceneEl) return;
    this.sceneEl.toggleClass('mobile-mode', this.mobileMode);
    // Disable heavy visual effects on mobile
    const buildings = this.sceneEl.querySelectorAll('.ai-village-building-glow, .ai-village-building-smoke');
    buildings.forEach(el => el.style.display = this.mobileMode ? 'none' : '');
    // Reduce sprite layer complexity
    this.spriteLayerEl.style.willChange = this.mobileMode ? 'auto' : 'transform';
  }

  setupTouchPanning() {
    if (!this.sceneWrapEl) return;
    this.sceneWrapEl.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        this.touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        this.isPanning = false;
      }
    }, { passive: true });

    this.sceneWrapEl.addEventListener('touchmove', (e) => {
      if (!this.touchStart || e.touches.length !== 1) return;
      const dx = e.touches[0].clientX - this.touchStart.x;
      const dy = e.touches[0].clientY - this.touchStart.y;
      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
        this.isPanning = true;
        this.scenePan.x += dx * 0.5;
        this.scenePan.y += dy * 0.5;
        // Clamp panning
        const maxPan = 200;
        this.scenePan.x = Math.max(-maxPan, Math.min(maxPan, this.scenePan.x));
        this.scenePan.y = Math.max(-maxPan, Math.min(maxPan, this.scenePan.y));
        this.spriteLayerEl.style.transform = `translate(${this.scenePan.x}px, ${this.scenePan.y}px)`;
      }
    }, { passive: true });

    this.sceneWrapEl.addEventListener('touchend', () => {
      this.touchStart = null;
      // Reset pan after a delay
      setTimeout(() => {
        if (!this.isPanning) return;
        this.isPanning = false;
        this.spriteLayerEl.style.transition = 'transform 0.3s ease-out';
        this.spriteLayerEl.style.transform = 'translate(0, 0)';
        setTimeout(() => {
          this.spriteLayerEl.style.transition = '';
        }, 300);
      }, 1000);
    });
  }

  async onClose() {
    if (this.unsub) this.unsub();
    if (this.wanderInterval) window.clearInterval(this.wanderInterval);
    if (this.tickInterval) window.clearInterval(this.tickInterval);
    if (this.gameLoop) window.clearInterval(this.gameLoop);
    for (const t of this.meetingTimers.values()) clearTimeout(t);
  }

  isNight() {
    if (this.nightMode === 'day') return false;
    if (this.nightMode === 'night') return true;
    const h = new Date().getHours();
    return h >= 19 || h < 6;
  }

  applyNightMode() {
    if (!this.sceneEl) return;
    this.sceneEl.toggleClass('is-night', this.isNight());
    this.sync();
  }

  getSeatPosition(prof, v) {
    if (v.assignedSeat) {
      const building = VILLAGE_BUILDINGS[prof.building];
      if (building && building.seats) {
        for (const seat of building.seats) {
          if (`${prof.building}-${seat.x}-${seat.y}` === v.assignedSeat) {
            return cartesianToIso(seat.x, seat.y);
          }
        }
      }
    }
    return null;
  }

  jitter(anchor, key) {
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
    const angle = (h % 360) * (Math.PI / 180);
    const radius = 3 + (h % 5);
    return {
      x: Math.min(96, Math.max(4, anchor.x + Math.cos(angle) * radius + (Math.random() * 4 - 2))),
      y: Math.min(96, Math.max(4, anchor.y + Math.sin(angle) * radius + (Math.random() * 4 - 2))),
    };
  }

  jitterIso(cartAnchor, key) {
    const iso = cartesianToIso(cartAnchor.x, cartAnchor.y);
    return this.jitter(iso, key);
  }

  doorStagger(key) {
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
    return ((h % 9) - 4) * 0.9;
  }

  gameTick() {
    const village = this.plugin.village;
    village.tickAnimations();

    for (const [key, v] of village.villagers) {
      if (v.status !== 'walking') continue;
      const el = this.villagerEls.get(key);
      if (!el) continue;
      const prof = VILLAGE_PROFESSIONS[v.professionKey];
      if (!prof || !prof.spriteDir) continue;

      const curX = parseFloat(el.style.left);
      const curY = parseFloat(el.style.top);
      const prev = this.prevPositions.get(key);
      if (prev && Number.isFinite(prev.x) && Number.isFinite(prev.y)) {
        const dx = curX - prev.x;
        const dy = curY - prev.y;
        if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) {
          const dir = villageDirectionFor(dx, dy);
          if (dir) {
            this.villagerFacing.set(key, dir);
            const img = el.querySelector('.ai-village-villager-img');
            if (img) img.src = this.plugin.getSpriteUrl(prof.spriteDir, dir);
          }
        }
      }
      this.prevPositions.set(key, { x: curX, y: curY });
    }

    this.syncBubbles();

    if (this.subagentTab.hasClass('is-active')) {
      this.renderSubagentList();
    }

    if (this.diagPanel.style.display !== 'none') {
      this.renderDiagnostics();
    }
  }

  syncBubbles() {
    const village = this.plugin.village;
    const now = Date.now();
    for (const [key, v] of village.villagers) {
      const el = this.villagerEls.get(key);
      if (!el) continue;
      const bubbleEl = el.querySelector('.ai-village-villager-bubble');
      if (!bubbleEl) continue;

      if (v.bubble && (v.bubble.expiresAt === 0 || now < v.bubble.expiresAt)) {
        bubbleEl.setText(`${v.bubble.icon || ''} ${v.bubble.text}`.trim());
        bubbleEl.style.display = 'block';
        el.addClass('has-bubble');
      } else if (!v.bubble || now >= v.bubble.expiresAt) {
        if (v.bubble && now >= v.bubble.expiresAt && v.bubble.expiresAt !== 0) {
          village.clearBubble(key);
        }
        if (!this.chattingUntil.has(key)) {
          bubbleEl.setText('');
          bubbleEl.style.display = '';
          el.removeClass('has-bubble');
        }
      }
    }
  }

  moveVillager(key, el, prof, x, y) {
    if (prof && prof.spriteDir) {
      const oldX = parseFloat(el.style.left);
      const oldY = parseFloat(el.style.top);
      const dir = Number.isFinite(oldX) && Number.isFinite(oldY) ? villageDirectionFor(x - oldX, y - oldY) : null;
      if (dir) {
        this.villagerFacing.set(key, dir);
        const img = el.querySelector('.ai-village-villager-img');
        if (img) img.src = this.plugin.getSpriteUrl(prof.spriteDir, dir);
      }
    }
    el.style.left = `${x}%`;
    el.style.top = `${y}%`;
  }

  wanderTick() {
    const village = this.plugin.village;
    const night = this.isNight();
    const now = Date.now();

    for (const [key, v] of village.villagers) {
      if (v.isSubagent) continue;
      const el = this.villagerEls.get(key);
      if (!el) continue;
      const isOut = v.status === 'idle' || v.status === 'finished' || v.status === 'waiting' || v.status === 'reviewing';
      const isWalking = v.status === 'walking';
      if (!isOut && !isWalking) { this.wanderTargets.delete(key); continue; }
      if (isWalking) { this.wanderTargets.delete(key); continue; }

      const prof = VILLAGE_PROFESSIONS[v.professionKey];
      if (!prof) continue;

      if (night && v.status === 'idle') {
        const anchor = VILLAGE_BUILDINGS[prof.building];
        const curX = parseFloat(el.style.left);
        const curY = parseFloat(el.style.top);
        const isoHome = cartesianToIso(anchor.x, anchor.y + 3);
        if (!Number.isFinite(curX) || Math.abs(curX - isoHome.x) > 2 || Math.abs(curY - isoHome.y) > 2) {
          this.moveVillager(key, el, prof, isoHome.x, isoHome.y);
        }
        this.wanderTargets.delete(key);
        continue;
      }

      let target = this.wanderTargets.get(key);
      const curX = parseFloat(el.style.left);
      const curY = parseFloat(el.style.top);
      const arrived = !target || (Math.abs(curX - target.x) < 2.5 && Math.abs(curY - target.y) < 2.5);

      if (arrived) {
        if (v.status === 'idle' && now < v.wanderPauseUntil) {
          continue;
        }
        v.wanderPauseUntil = now + 2500 + Math.random() * 3000;
        target = this.pickWanderTarget(key, prof);
        this.wanderTargets.set(key, target);
      }
      this.moveVillager(key, el, prof, target.x, target.y);

      if (v.status === 'idle') {
        const tagEl = el.querySelector('.ai-village-villager-tag');
        if (tagEl) {
          const idleLine = prof.idle[Math.floor(Math.random() * prof.idle.length)];
          tagEl.setText(`${v.name} ${idleLine}`);
        }
      }
    }

    this.chatTick();
  }

  pickWanderTarget(key, prof) {
    if (Math.random() < 0.25) {
      const anchor = VILLAGE_BUILDINGS[prof.building];
      return this.jitterIso(anchor, key + Math.random());
    }
    return cartesianToIso(8 + Math.random() * 84, 8 + Math.random() * 84);
  }

  chatTick() {
    const village = this.plugin.village;
    const night = this.isNight();
    const now = Date.now();

    for (const [key, until] of Array.from(this.chattingUntil.entries())) {
      if (until <= now) {
        this.chattingUntil.delete(key);
        const el = this.villagerEls.get(key);
        if (el) {
          el.removeClass('is-chatting');
          const bubble = el.querySelector('.ai-village-villager-bubble');
          if (bubble) bubble.setText('');
        }
      }
    }

    if (night) return;

    const candidates = [];
    for (const [key, v] of village.villagers) {
      if (v.isSubagent) continue;
      if (v.status !== 'idle') continue;
      if (this.villagerHidden.has(key) || this.chattingUntil.has(key)) continue;
      if ((this.chatCooldown.get(key) || 0) > now) continue;
      const el = this.villagerEls.get(key);
      if (!el) continue;
      const x = parseFloat(el.style.left);
      const y = parseFloat(el.style.top);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      candidates.push({ key, v, x, y });
    }

    for (let i = 0; i < candidates.length; i++) {
      const a = candidates[i];
      if (this.chattingUntil.has(a.key)) continue;
      for (let j = i + 1; j < candidates.length; j++) {
        const b = candidates[j];
        if (this.chattingUntil.has(b.key)) continue;
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (dist > 9) continue;
        if (Math.random() > 0.35) continue;
        this.startChat(a, b);
        break;
      }
    }
  }

  startChat(a, b) {
    const line = VILLAGE_SMALLTALK[Math.floor(Math.random() * VILLAGE_SMALLTALK.length)];
    const until = Date.now() + 3200;
    for (const p of [a, b]) {
      this.chattingUntil.set(p.key, until);
      this.chatCooldown.set(p.key, until + 6000 + Math.random() * 8000);
      const el = this.villagerEls.get(p.key);
      if (el) {
        el.addClass('is-chatting');
        const bubble = el.querySelector('.ai-village-villager-bubble');
        if (bubble) bubble.setText(line);
      }
    }
    this.plugin.village.say(a.key, `chats with ${b.v.name}: "${line}"`);
  }

  toggleDiagnostics() {
    if (this.diagPanel.style.display === 'none') {
      this.diagPanel.style.display = 'block';
      this.renderDiagnostics();
    } else {
      this.diagPanel.style.display = 'none';
    }
  }

  renderDiagnostics() {
    const village = this.plugin.village;
    this.diagPanel.empty();
    const header = this.diagPanel.createDiv({ cls: 'ai-village-diag-header', text: 'Tool History' });
    const closeBtn = header.createEl('span', { cls: 'ai-village-diag-close', text: '✕' });
    closeBtn.addEventListener('click', () => { this.diagPanel.style.display = 'none'; });

    let hasEntries = false;
    for (const [key, v] of village.villagers) {
      if (!v.toolHistory || v.toolHistory.length === 0) continue;
      hasEntries = true;
      const section = this.diagPanel.createDiv({ cls: 'ai-village-diag-agent' });
      section.createDiv({ cls: 'ai-village-diag-agent-name', text: v.name });
      const list = section.createDiv({ cls: 'ai-village-diag-list' });
      const recent = v.toolHistory.slice(-10);
      for (const entry of recent) {
        const row = list.createDiv({ cls: `ai-village-diag-entry ${entry.status === 'error' ? 'is-error' : ''}` });
        const toolSpan = row.createSpan({ cls: 'ai-village-diag-tool', text: entry.tool });
        if (entry.args) {
          row.createSpan({ cls: 'ai-village-diag-args', text: ` ${entry.args}` });
        }
        if (entry.result) {
          row.createSpan({ cls: 'ai-village-diag-result', text: ` → ${entry.result}` });
        }
        if (entry.status === 'error') row.addClass('is-error');
      }
    }

    if (!hasEntries) {
      this.diagPanel.createDiv({ cls: 'ai-village-diag-empty', text: 'No tool calls yet — run an agent to see its activity.' });
    }
  }

  renderSubagentList() {
    const village = this.plugin.village;
    this.subagentEl.empty();

    const agents = Array.from(village.villagers.values());
    if (agents.length === 0) {
      this.subagentEl.createDiv({ cls: 'ai-village-agent-row', text: 'No agents in the village.' });
      return;
    }

    for (const v of agents) {
      const row = this.subagentEl.createDiv({ cls: `ai-village-agent-row ${v.isSubagent ? 'is-subagent' : ''}` });
      const prof = VILLAGE_PROFESSIONS[v.professionKey];
      const emoji = prof ? prof.emoji : '👤';
      const badge = v.isSubagent ? '⊶ ' : '';
      const parentInfo = v.isSubagent && v.parentKey ? ` (for ${village.villagers.get(v.parentKey)?.name || v.parentKey})` : '';
      row.createSpan({ cls: 'ai-village-agent-emoji', text: `${badge}${emoji}` });
      row.createSpan({ cls: 'ai-village-agent-name', text: `${v.name}${parentInfo}` });
      const statusSpan = row.createSpan({ cls: 'ai-village-agent-status', text: ` ${v.status}${v.subStatus ? `:${v.subStatus}` : ''}` });
      if (v.status === 'error') statusSpan.addClass('is-error');
      else if (v.status === 'finished') statusSpan.addClass('is-finished');
      if (v.taskText) {
        row.createSpan({ cls: 'ai-village-agent-task', text: ` "${v.taskText.slice(0, 60)}"` });
      }
    }
  }

  ensureVillagerEl(key, v) {
    let el = this.villagerEls.get(key);
    if (el) return el;
    const prof = VILLAGE_PROFESSIONS[v.professionKey];
    const isSub = v.isSubagent;

    el = this.spriteLayerEl.createDiv({ cls: `ai-village-villager ${isSub ? 'is-subagent' : ''}` });

    if (prof && prof.spriteDir && !isSub) {
      const sprite = el.createDiv({ cls: 'ai-village-villager-sprite' });
      const img = sprite.createEl('img', { cls: 'ai-village-villager-img' });
      const markFailed = () => {
        if (this.spriteFailed.has(key)) return;
        this.spriteFailed.add(key);
        el.addClass('sprite-failed');
      };
      img.onerror = markFailed;
      img.onload = () => {
        if (!img.naturalWidth) markFailed();
      };
      img.src = this.plugin.getSpriteUrl(prof.spriteDir, 'south');
      if (!img.src) markFailed();
      window.setTimeout(() => {
        if (!img.complete || !img.naturalWidth) markFailed();
      }, 4000);
      this.villagerFacing.set(key, 'south');
      el.createDiv({ cls: 'ai-village-villager-badge ai-village-villager-fallback-badge', text: prof.emoji });
    } else {
      const badgeText = isSub ? '◈' : (prof ? prof.emoji : '👤');
      el.createDiv({ cls: `ai-village-villager-badge ${isSub ? 'is-subagent-badge' : ''}`, text: badgeText });
    }

    el.createDiv({ cls: 'ai-village-villager-mood', text: '🙂' });
    const bubbleEl = el.createDiv({ cls: 'ai-village-villager-bubble' });
    bubbleEl.style.display = 'none';
    el.createDiv({ cls: 'ai-village-villager-tag', text: v.name });
    el.createDiv({ cls: 'ai-village-villager-activity' });

    // Tap to show speech bubble on mobile
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const v = this.plugin.village.villagers.get(key);
      if (v && v.bubble && v.bubble.text) {
        bubbleEl.setText(`${v.bubble.icon || ''} ${v.bubble.text}`.trim());
        bubbleEl.style.display = 'block';
        el.addClass('has-bubble');
        // Auto-hide after 3 seconds
        setTimeout(() => {
          bubbleEl.style.display = 'none';
          el.removeClass('has-bubble');
        }, 3000);
      }
    }, { passive: true });

    // Touch support for mobile - long press to show bubble
    let touchTimer = null;
    el.addEventListener('touchstart', (e) => {
      touchTimer = setTimeout(() => {
        const v = this.plugin.village.villagers.get(key);
        if (v && v.bubble && v.bubble.text) {
          bubbleEl.setText(`${v.bubble.icon || ''} ${v.bubble.text}`.trim());
          bubbleEl.style.display = 'block';
          el.addClass('has-bubble');
          setTimeout(() => {
            bubbleEl.style.display = 'none';
            el.removeClass('has-bubble');
          }, 3000);
        }
      }, 500);
    }, { passive: true });
    el.addEventListener('touchend', () => {
      if (touchTimer) clearTimeout(touchTimer);
    }, { passive: true });
    el.addEventListener('touchmove', () => {
      if (touchTimer) clearTimeout(touchTimer);
    }, { passive: true });

    const anchor = prof ? VILLAGE_BUILDINGS[prof.building] : { x: 50, y: 50 };
    const pos = prof ? this.jitterIso(anchor, key) : { x: 20 + Math.random() * 60, y: 20 + Math.random() * 60 };
    el.style.left = `${pos.x}%`;
    el.style.top = `${pos.y}%`;
    if (isSub) {
      el.style.transform = 'translate(-50%, -50%) scale(0.7)';
      el.style.opacity = '0.85';
    }
    this.spriteLayerEl.appendChild(el);
    this.villagerEls.set(key, el);
    return el;
  }

  sync() {
    if (!this.sceneEl) return;
    const village = this.plugin.village;
    const night = this.isNight();
    const collaboratingKeys = new Set();
    for (const m of village.messengers) {
      collaboratingKeys.add(m.fromKey);
      collaboratingKeys.add(m.toKey);
    }

    const buildingStatus = new Map();
    for (const [key, v] of village.villagers) {
      const el = this.ensureVillagerEl(key, v);
      const prof = VILLAGE_PROFESSIONS[v.professionKey];
      if (v.status !== 'idle' && this.chattingUntil.has(key)) {
        this.chattingUntil.delete(key);
        el.removeClass('is-chatting');
        const bubble = el.querySelector('.ai-village-villager-bubble');
        if (bubble) bubble.setText('');
      }

      el.className = `ai-village-villager status-${v.status}`;
      if (v.isSubagent) el.addClass('is-subagent');
      el.toggleClass('sprite-failed', this.spriteFailed.has(key));
      const sleeping = night && v.status === 'idle';
      const collaborating = collaboratingKeys.has(key);
      const chatting = this.chattingUntil.has(key);
      el.toggleClass('is-sleeping', sleeping);
      el.toggleClass('is-collaborating', collaborating);
      el.toggleClass('is-hidden', this.villagerHidden.has(key));
      el.toggleClass('is-chatting', chatting);

      el.querySelector('.ai-village-villager-mood').setText(
        villageMoodIcon(v.status, v.subStatus, sleeping ? 'sleeping' : chatting ? 'chatting' : collaborating ? 'collaborating' : null)
      );

      const sl = skillLevel(v.experience || 0);
      const lvlBadge = v.experience > 0 ? ` [${sl.title.slice(0, 4)}]` : '';
      const tagEl = el.querySelector('.ai-village-villager-tag');
      if (v.isSubagent) {
        tagEl.setText(`[sub] ${v.taskText || v.name}`);
      } else if (v.status === 'walking') {
        tagEl.setText(`${v.name}${lvlBadge} is on the move`);
      } else if (v.status === 'working' || v.status === 'reviewing' || v.status === 'waiting' || v.status === 'error') {
        tagEl.setText(v.taskText ? `${v.name}${lvlBadge}: ${v.taskText}` : `${v.name}${lvlBadge}`);
      } else if (v.status === 'meeting') {
        tagEl.setText(v.taskText ? `${v.name}${lvlBadge}: ${v.taskText}` : `${v.name}${lvlBadge} at the Town Hall`);
      } else if (v.status === 'finished') {
        tagEl.setText(`${v.name}${lvlBadge} ✓ ${v.taskText || 'done'}`);
      } else if (sleeping) {
        tagEl.setText(`${v.name}${lvlBadge} is asleep`);
      } else {
        tagEl.setText(`${v.name}${lvlBadge}`);
      }
      // Add CSS class for skill level
      el.toggleClass('is-master', sl.level >= 4);
      el.toggleClass('is-expert', sl.level >= 3 && sl.level < 4);

      const activityEl = el.querySelector('.ai-village-villager-activity');
      if (v.subStatus === 'reading') {
        activityEl.setText('📖');
        el.addClass('is-reading');
        el.removeClass('is-writing');
        el.style.transition = 'left 3.6s ease-in-out, top 3.6s ease-in-out, opacity 0.5s ease';
      } else if (v.subStatus === 'writing') {
        activityEl.setText('✍️');
        el.addClass('is-writing');
        el.removeClass('is-reading');
        el.style.transition = 'left 3.6s ease-in-out, top 3.6s ease-in-out, opacity 0.5s ease';
      } else {
        activityEl.setText('');
        el.removeClass('is-reading is-writing');
      }

      const prevStatus = this.prevStatus.get(key);

      if (v.status === 'walking') {
        el.style.transition = 'left 1.2s ease-in-out, top 1.2s ease-in-out, opacity 0.5s ease';
        if (v.walkTarget) {
          const iso = cartesianToIso(v.walkTarget.x, v.walkTarget.y);
          this.moveVillager(key, el, prof, iso.x, iso.y);
        }
      } else if ((v.status === 'working' || v.status === 'error') && !v.isSubagent) {
        el.style.transition = 'left 0.9s ease, top 0.9s ease, opacity 0.5s ease';
        let pos = null;
        if (prof) pos = this.getSeatPosition(prof, v);
        if (!pos) {
          const anchor = prof ? VILLAGE_BUILDINGS[prof.building] : { x: 50, y: 50 };
          pos = cartesianToIso(anchor.x, anchor.y + 3);
        }
        this.moveVillager(key, el, prof, pos.x, pos.y);
      } else if (v.status === 'meeting') {
        if (prevStatus !== 'meeting') {
          const anchor = VILLAGE_BUILDINGS.townhall;
          const isoMeeting = cartesianToIso(anchor.x + this.doorStagger(key), anchor.y + 3);
          this.moveVillager(key, el, prof, isoMeeting.x, isoMeeting.y);
          this.villagerHidden.delete(key);
          el.removeClass('is-hidden');
          clearTimeout(this.meetingTimers.get(key));
          const hideTimer = window.setTimeout(() => {
            this.villagerHidden.add(key);
            el.addClass('is-hidden');
          }, 950);
          this.meetingTimers.set(key, hideTimer);
        }
      } else if (prevStatus === 'meeting') {
        clearTimeout(this.meetingTimers.get(key));
        this.villagerHidden.delete(key);
        el.removeClass('is-hidden');
        if (prof) {
          const anchor = VILLAGE_BUILDINGS[prof.building];
          const homeTimer = window.setTimeout(() => {
            const isoHome = cartesianToIso(anchor.x, anchor.y + 3);
            this.moveVillager(key, el, prof, isoHome.x, isoHome.y);
          }, 650);
          this.meetingTimers.set(key, homeTimer);
        }
      }
      this.prevStatus.set(key, v.status);

      const bKey = v.status === 'meeting' ? 'townhall' : (prof ? prof.building : null);
      if (bKey) {
        const rank = VILLAGE_STATUS_PRIORITY.indexOf(v.status);
        const cur = buildingStatus.get(bKey);
        if (cur === undefined || rank < VILLAGE_STATUS_PRIORITY.indexOf(cur)) {
          buildingStatus.set(bKey, v.status);
        }
      }
    }

    const activeCount = Array.from(village.villagers.values()).filter((v) => v.status === 'working' && !v.isSubagent).length;
    this.sceneEl.toggleClass('is-busy', activeCount >= 3);
    for (const [key, el] of this.buildingEls) {
      const status = buildingStatus.get(key);
      el.className = `ai-village-building${status ? ` is-${status}` : ''}`;
    }

    const liveIds = new Set();
    for (const m of village.messengers) {
      liveIds.add(m.id);
      if (!this.messengerEls.has(m.id)) {
        const fromProf = VILLAGE_PROFESSIONS[village.villagers.get(m.fromKey)?.professionKey || 'mayor'];
        const toProf = VILLAGE_PROFESSIONS[village.villagers.get(m.toKey)?.professionKey || 'mayor'];
        const fromB = fromProf ? VILLAGE_BUILDINGS[fromProf.building] : { x: 50, y: 50 };
        const toB = toProf ? VILLAGE_BUILDINGS[toProf.building] : { x: 50, y: 50 };
        const fromIso = cartesianToIso(fromB.x, fromB.y);
        const toIso = cartesianToIso(toB.x, toB.y);
        const el = this.spriteLayerEl.createDiv({ cls: 'ai-village-messenger', text: '📜' });
        el.style.left = `${fromIso.x}%`;
        el.style.top = `${fromIso.y}%`;
        this.spriteLayerEl.appendChild(el);
        this.messengerEls.set(m.id, el);
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            el.style.left = `${toIso.x}%`;
            el.style.top = `${toIso.y}%`;
          });
        });
      }
    }
    for (const [id, el] of this.messengerEls) {
      if (!liveIds.has(id)) {
        el.remove();
        this.messengerEls.delete(id);
      }
    }

    for (const el of this.spriteLayerEl.children) {
      const top = parseFloat(el.style.top);
      if (Number.isFinite(top)) {
        el.style.zIndex = Math.round(top * 20);
      }
    }

    if (this.taskQueueEl) {
      const qlen = village.taskQueueLength ? village.taskQueueLength() : 0;
      if (qlen > 0) {
        this.taskQueueEl.setText(`📋 ${qlen}`);
        this.taskQueueEl.addClass('has-queued');
      } else {
        this.taskQueueEl.setText('');
        this.taskQueueEl.removeClass('has-queued');
      }
    }

    this.feedEl.empty();
    const recent = village.feed.slice(-14);
    for (const entry of recent) {
      const row = this.feedEl.createDiv({ cls: 'ai-village-feed-row' });
      row.createSpan({ cls: 'ai-village-feed-from', text: entry.from + ': ' });
      row.createSpan({ cls: 'ai-village-feed-text', text: entry.text });
    }
    this.feedEl.scrollTop = this.feedEl.scrollHeight;

    this.consoleEl.empty();
    const consoleEntries = village.consoleEntries;
    for (const entry of consoleEntries) {
      const row = this.consoleEl.createDiv({ cls: `ai-village-console-row level-${entry.level}` });
      const time = new Date(entry.ts);
      const timeStr = time.getHours().toString().padStart(2, '0') + ':' + time.getMinutes().toString().padStart(2, '0') + ':' + time.getSeconds().toString().padStart(2, '0');
      row.createSpan({ cls: 'ai-village-console-time', text: timeStr });
      row.createSpan({ cls: 'ai-village-console-level', text: '[' + entry.level.toUpperCase() + ']' });
      row.createSpan({ cls: 'ai-village-console-text', text: entry.message });
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        const full = timeStr + ' [' + entry.level.toUpperCase() + '] ' + entry.message;
        navigator.clipboard.writeText(full).catch(() => {});
      });
    }
    this.consoleEl.scrollTop = this.consoleEl.scrollHeight;
  }
}

module.exports = { VillageView };
