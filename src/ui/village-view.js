'use strict';

const { ItemView } = require('obsidian');
const { VIEW_TYPE_AI_VILLAGE } = require('../core/constants');
const { VILLAGE_BUILDINGS, VILLAGE_PROFESSIONS, VILLAGE_SMALLTALK } = require('../village/village-roster');

const VILLAGE_STATUS_PRIORITY = ['error', 'working', 'meeting', 'reviewing', 'waiting', 'finished', 'idle'];

function villageMoodIcon(status, extra) {
  if (status === 'error') return '⚠️';
  if (status === 'finished') return '✨';
  if (extra === 'sleeping') return '😴';
  if (extra === 'chatting') return '💬';
  if (extra === 'collaborating') return '🤝';
  if (status === 'working') return '⚙️';
  if (status === 'meeting') return '🗣️';
  if (status === 'reviewing') return '💭';
  if (status === 'waiting') return '⌛';
  return '🙂';
}

// Character art ships as 8 compass-direction frames. Given a movement delta (in the same
// % coordinate space used for positioning), pick the nearest of the 8 — index 0 is due
// east and the list runs clockwise (screen y grows downward, so positive dy is south).
const VILLAGE_SPRITE_DIRS = ['east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north', 'north-east'];
function villageDirectionFor(dx, dy) {
  if (Math.abs(dx) < 0.05 && Math.abs(dy) < 0.05) return null;
  const angle = Math.atan2(dy, dx) * (180 / Math.PI);
  const idx = (Math.round(angle / 45) + 8) % 8;
  return VILLAGE_SPRITE_DIRS[idx];
}

/**
 * The village: a living-settlement view of every AI "villager" (the chat sidebar as the
 * Innkeeper, the Organize command as the Librarian, and every solo/team Agent — a solo
 * Agent is the Mayor, team members map onto the rest of the 19-villager roster). Purely
 * a renderer over VillageStore — it never calls any AI provider itself.
 */
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
    // Meeting fade-out/in: remembers each villager's previous status (to detect the
    // moment they enter/leave a meeting) and any in-flight timers for that transition.
    this.prevStatus = new Map();
    this.meetingTimers = new Map();
    this.villagerHidden = new Set();
    // Ambient small talk between two idle villagers who wander near each other.
    this.chattingUntil = new Map();
    this.chatCooldown = new Map();
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
    legend.createSpan({ text: '⚙️ working  🗣️ meeting  💭 reviewing  ⌛ waiting  ✨ finished  ⚠️ error' });
    this.nightBtn = toolbar.createEl('button', { cls: 'ai-village-night-toggle', text: '🌓 Auto' });
    this.nightBtn.addEventListener('click', () => {
      this.nightMode = this.nightMode === 'auto' ? 'day' : this.nightMode === 'day' ? 'night' : 'auto';
      this.nightBtn.setText(
        this.nightMode === 'auto' ? '🌓 Auto' : this.nightMode === 'day' ? '☀️ Day' : '🌙 Night'
      );
      this.applyNightMode();
    });

    const sceneWrap = container.createDiv({ cls: 'ai-village-scene-wrap' });
    this.sceneEl = sceneWrap.createDiv({ cls: 'ai-village-scene' });
    if (this.plugin.villageMapUrl) {
      this.sceneEl.style.backgroundImage = `url("${this.plugin.villageMapUrl}")`;
    }
    this.nightOverlayEl = this.sceneEl.createDiv({ cls: 'ai-village-night-overlay' });
    this.spriteLayerEl = this.sceneEl.createDiv({ cls: 'ai-village-sprite-layer' });

    for (const [key, b] of Object.entries(VILLAGE_BUILDINGS)) {
      const el = this.spriteLayerEl.createDiv({ cls: 'ai-village-building' });
      el.style.left = `${b.x}%`;
      el.style.top = `${b.y}%`;
      el.createDiv({ cls: 'ai-village-building-glow' });
      el.createDiv({ cls: 'ai-village-building-smoke' });
      const bar = el.createDiv({ cls: 'ai-village-building-bar' });
      bar.createDiv({ cls: 'ai-village-building-bar-fill' });
      el.createDiv({ cls: 'ai-village-building-banner', text: '⚠' });
      el.createDiv({ cls: 'ai-village-building-label', text: b.label });
      this.buildingEls.set(key, el);
    }

    const feedWrap = container.createDiv({ cls: 'ai-village-feed-wrap' });
    feedWrap.createDiv({ cls: 'ai-village-feed-title', text: 'Village chatter' });
    this.feedEl = feedWrap.createDiv({ cls: 'ai-village-feed' });

    this.unsub = this.plugin.village.subscribe(() => this.sync());
    this.wanderInterval = window.setInterval(() => this.wanderTick(), 4200);
    this.tickInterval = window.setInterval(() => this.applyNightMode(), 60000);

    this.applyNightMode();
    this.wanderTick();
    this.sync();
  }

  async onClose() {
    if (this.unsub) this.unsub();
    if (this.wanderInterval) window.clearInterval(this.wanderInterval);
    if (this.tickInterval) window.clearInterval(this.tickInterval);
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

  jitter(anchor, key) {
    // Deterministic-ish per villager so different villagers at the same building don't overlap.
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
    const angle = (h % 360) * (Math.PI / 180);
    const radius = 3 + (h % 5);
    return {
      x: Math.min(96, Math.max(4, anchor.x + Math.cos(angle) * radius + (Math.random() * 4 - 2))),
      y: Math.min(96, Math.max(4, anchor.y + Math.sin(angle) * radius + (Math.random() * 4 - 2))),
    };
  }

  // A small, stable (non-random-per-frame) left/right offset so several villagers standing
  // at the same doorway line up next to each other instead of rendering as one stacked
  // sprite — used for "everyone walks inside and stands at the door" states like meetings.
  doorStagger(key) {
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
    return ((h % 9) - 4) * 0.9; // ~ -3.6 .. +3.6
  }

  // Moves a villager's element to (x, y) in % coordinates and, if it has character art,
  // updates the sprite frame to face the direction of travel.
  moveVillager(key, el, prof, x, y) {
    if (prof.spriteDir) {
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

    for (const [key, v] of village.villagers) {
      const el = this.villagerEls.get(key);
      if (!el) continue;
      const isOut = v.status === 'idle' || v.status === 'finished' || v.status === 'waiting' || v.status === 'reviewing';
      if (!isOut) { this.wanderTargets.delete(key); continue; } // "working"/"meeting" handled in sync()
      const prof = VILLAGE_PROFESSIONS[v.professionKey];

      if (night && v.status === 'idle') {
        // Turned in for the night — head home once, then hold still (dimmed via is-sleeping).
        const anchor = VILLAGE_BUILDINGS[prof.building];
        const curX = parseFloat(el.style.left);
        const curY = parseFloat(el.style.top);
        if (!Number.isFinite(curX) || Math.abs(curX - anchor.x) > 2 || Math.abs(curY - (anchor.y + 3)) > 2) {
          this.moveVillager(key, el, prof, anchor.x, anchor.y + 3);
        }
        this.wanderTargets.delete(key);
        continue;
      }

      // Roam the whole village rather than sticking close to home/work — occasionally
      // loops back near their own building, but mostly wanders freely.
      let target = this.wanderTargets.get(key);
      const curX = parseFloat(el.style.left);
      const curY = parseFloat(el.style.top);
      const arrived = !target || (Math.abs(curX - target.x) < 2.5 && Math.abs(curY - target.y) < 2.5);
      if (arrived) {
        target = this.pickWanderTarget(key, prof);
        this.wanderTargets.set(key, target);
      }
      this.moveVillager(key, el, prof, target.x, target.y);

      if (v.status === 'idle') {
        const tagEl = el.querySelector('.ai-village-villager-tag');
        if (tagEl) tagEl.setText(`${v.name} ${prof.idle[Math.floor(Math.random() * prof.idle.length)]}`);
      }
    }

    this.chatTick();
  }

  // Mostly a free-roam point anywhere on the map; sometimes drifts back toward home/work
  // so it still looks like a villager living there, not just wandering aimlessly forever.
  pickWanderTarget(key, prof) {
    if (Math.random() < 0.25) {
      const anchor = VILLAGE_BUILDINGS[prof.building];
      return this.jitter(anchor, key + Math.random());
    }
    return { x: 8 + Math.random() * 84, y: 8 + Math.random() * 84 };
  }

  // Ambient life: when two idle villagers happen to be wandering near each other, they stop
  // for a moment and chat — a speech bubble over each, plus a line in the feed. Each villager
  // gets a cooldown afterward so the same two don't chat nonstop.
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

  ensureVillagerEl(key, v) {
    let el = this.villagerEls.get(key);
    if (el) return el;
    const prof = VILLAGE_PROFESSIONS[v.professionKey];
    el = this.spriteLayerEl.createDiv({ cls: 'ai-village-villager' });
    if (prof.spriteDir) {
      const sprite = el.createDiv({ cls: 'ai-village-villager-sprite' });
      const img = sprite.createEl('img', { cls: 'ai-village-villager-img' });
      const markFailed = () => {
        if (this.spriteFailed.has(key)) return;
        this.spriteFailed.add(key);
        el.addClass('sprite-failed');
      };
      img.onerror = markFailed;
      img.onload = () => {
        // Some mobile webviews resolve a missing local resource as a blank 0×0 image instead
        // of firing 'error' — treat that as a failure too.
        if (!img.naturalWidth) markFailed();
      };
      img.src = this.plugin.getSpriteUrl(prof.spriteDir, 'south');
      if (!img.src) markFailed();
      // Belt-and-braces: if neither load nor error has resolved after a few seconds (some
      // mobile webviews silently swallow both events for blocked/missing local resources),
      // fall back anyway rather than leaving the villager looking like a bare floating emoji.
      window.setTimeout(() => {
        if (!img.complete || !img.naturalWidth) markFailed();
      }, 4000);
      this.villagerFacing.set(key, 'south');
      el.createDiv({ cls: 'ai-village-villager-badge ai-village-villager-fallback-badge', text: prof.emoji });
    } else {
      el.createDiv({ cls: 'ai-village-villager-badge', text: prof.emoji });
    }
    el.createDiv({ cls: 'ai-village-villager-mood', text: '🙂' });
    el.createDiv({ cls: 'ai-village-villager-bubble' });
    el.createDiv({ cls: 'ai-village-villager-tag', text: v.name });
    const anchor = VILLAGE_BUILDINGS[prof.building];
    const pos = this.jitter(anchor, key);
    el.style.left = `${pos.x}%`;
    el.style.top = `${pos.y}%`;
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

    // Villagers
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
      el.toggleClass('sprite-failed', this.spriteFailed.has(key));
      const sleeping = night && v.status === 'idle';
      const collaborating = collaboratingKeys.has(key);
      const chatting = this.chattingUntil.has(key);
      el.toggleClass('is-sleeping', sleeping);
      el.toggleClass('is-collaborating', collaborating);
      el.toggleClass('is-hidden', this.villagerHidden.has(key));
      el.toggleClass('is-chatting', chatting);
      el.querySelector('.ai-village-villager-mood').setText(
        villageMoodIcon(v.status, sleeping ? 'sleeping' : chatting ? 'chatting' : collaborating ? 'collaborating' : null)
      );
      const tagEl = el.querySelector('.ai-village-villager-tag');
      if (v.status === 'working' || v.status === 'reviewing' || v.status === 'waiting' || v.status === 'error') {
        tagEl.setText(v.taskText ? `${v.name}: ${v.taskText}` : v.name);
      } else if (v.status === 'meeting') {
        tagEl.setText(v.taskText ? `${v.name}: ${v.taskText}` : `${v.name} at the Town Hall`);
      } else if (v.status === 'finished') {
        tagEl.setText(`${v.name} ✓ ${v.taskText || 'done'}`);
      } else if (sleeping) {
        tagEl.setText(`${v.name} is asleep`);
      } else {
        tagEl.setText(v.name);
      }

      const prevStatus = this.prevStatus.get(key);

      if (v.status === 'working' || v.status === 'error') {
        // Enters the building — pinned at the door, not wandering.
        const anchor = VILLAGE_BUILDINGS[prof.building];
        this.moveVillager(key, el, prof, anchor.x, anchor.y + 3);
      } else if (v.status === 'meeting') {
        if (prevStatus !== 'meeting') {
          // Just called in — walk to the Town Hall door, then duck inside (fade out) once
          // they've arrived, so the meeting itself happens out of sight.
          const anchor = VILLAGE_BUILDINGS.townhall;
          this.moveVillager(key, el, prof, anchor.x + this.doorStagger(key), anchor.y + 3);
          this.villagerHidden.delete(key);
          el.removeClass('is-hidden');
          clearTimeout(this.meetingTimers.get(key));
          const hideTimer = window.setTimeout(() => {
            this.villagerHidden.add(key);
            el.addClass('is-hidden');
          }, 950);
          this.meetingTimers.set(key, hideTimer);
        }
        // Already inside — leave position/visibility alone for the rest of the meeting.
      } else if (prevStatus === 'meeting') {
        // Meeting just ended — reappear at the Town Hall door, then head home a beat later.
        clearTimeout(this.meetingTimers.get(key));
        this.villagerHidden.delete(key);
        el.removeClass('is-hidden');
        const anchor = VILLAGE_BUILDINGS[prof.building];
        const homeTimer = window.setTimeout(() => {
          this.moveVillager(key, el, prof, anchor.x, anchor.y + 3);
        }, 650);
        this.meetingTimers.set(key, homeTimer);
      }
      this.prevStatus.set(key, v.status);

      const bKey = v.status === 'meeting' ? 'townhall' : prof.building;
      const rank = VILLAGE_STATUS_PRIORITY.indexOf(v.status);
      const cur = buildingStatus.get(bKey);
      if (cur === undefined || rank < VILLAGE_STATUS_PRIORITY.indexOf(cur)) {
        buildingStatus.set(bKey, v.status);
      }
    }

    // Buildings
    const activeCount = Array.from(village.villagers.values()).filter((v) => v.status === 'working').length;
    this.sceneEl.toggleClass('is-busy', activeCount >= 3);
    for (const [key, el] of this.buildingEls) {
      const status = buildingStatus.get(key);
      el.className = `ai-village-building${status ? ` is-${status}` : ''}`;
    }

    // Messengers
    const liveIds = new Set();
    for (const m of village.messengers) {
      liveIds.add(m.id);
      if (!this.messengerEls.has(m.id)) {
        const fromProf = VILLAGE_PROFESSIONS[village.villagers.get(m.fromKey)?.professionKey || 'mayor'];
        const toProf = VILLAGE_PROFESSIONS[village.villagers.get(m.toKey)?.professionKey || 'mayor'];
        const fromB = VILLAGE_BUILDINGS[fromProf.building];
        const toB = VILLAGE_BUILDINGS[toProf.building];
        const el = this.spriteLayerEl.createDiv({ cls: 'ai-village-messenger', text: '📜' });
        el.style.left = `${fromB.x}%`;
        el.style.top = `${fromB.y}%`;
        this.spriteLayerEl.appendChild(el);
        this.messengerEls.set(m.id, el);
        // Kick the transition off on the next frame so the browser registers the start position first.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            el.style.left = `${toB.x}%`;
            el.style.top = `${toB.y}%`;
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

    // Feed
    this.feedEl.empty();
    const recent = village.feed.slice(-14);
    for (const entry of recent) {
      const row = this.feedEl.createDiv({ cls: 'ai-village-feed-row' });
      row.createSpan({ cls: 'ai-village-feed-from', text: entry.from + ': ' });
      row.createSpan({ cls: 'ai-village-feed-text', text: entry.text });
    }
    this.feedEl.scrollTop = this.feedEl.scrollHeight;
  }
}

module.exports = { VillageView };
