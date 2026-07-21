'use strict';

const { VILLAGE_PROFESSIONS, VILLAGE_BUILDINGS } = require('./village-roster');

const READING_TOOLS = new Set(['list_files', 'read_note', 'read_notes', 'get_note_metadata', 'search_notes', 'search_web']);
const WRITING_TOOLS = new Set(['write_note', 'append_note', 'add_tags', 'move_note', 'rename_note', 'create_folder', 'delete_note']);

const BUBBLE_AUTO_FADE = 2500;

class VillageStore {
  constructor(plugin) {
    this.plugin = plugin;
    this.villagers = new Map();
    this.feed = [];
    this.consoleEntries = [];
    this.messengers = [];
    this.listeners = new Set();
    this._idleTimers = new Map();
    this._bubbleTimers = new Map();
    this._seatAssignments = new Map(); // buildingKey -> Set<villagerKey>
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit() {
    for (const fn of this.listeners) {
      try { fn(); } catch (e) { /* view may be mid-teardown */ }
    }
  }

  _nextSeat(buildingKey) {
    const building = VILLAGE_BUILDINGS[buildingKey];
    if (!building || !building.seats || building.seats.length === 0) return null;
    const assigned = this._seatAssignments.get(buildingKey);
    if (!assigned || assigned.size === 0) return building.seats[0];
    for (const seat of building.seats) {
      const key = `${buildingKey}-${seat.x}-${seat.y}`;
      let taken = false;
      for (const vkey of assigned) {
        const v = this.villagers.get(vkey);
        if (v && v.assignedSeat === key) { taken = true; break; }
      }
      if (!taken) return seat;
    }
    return null;
  }

  ensure(key, professionKey, name) {
    if (!VILLAGE_PROFESSIONS[professionKey]) professionKey = 'mayor';
    let v = this.villagers.get(key);
    if (!v) {
      const prof = VILLAGE_PROFESSIONS[professionKey];
      const building = VILLAGE_BUILDINGS[prof.building];
      const seat = this._nextSeat(prof.building);
      const seatKey = seat ? `${prof.building}-${seat.x}-${seat.y}` : null;
      if (seat) {
        if (!this._seatAssignments.has(prof.building)) this._seatAssignments.set(prof.building, new Set());
        this._seatAssignments.get(prof.building).add(key);
      }
      v = {
        key,
        name: name || prof.title,
        professionKey,
        status: 'idle',
        subStatus: null,
        mood: 'happy',
        taskText: '',
        bubble: null,
        facing: 'south',
        walkTarget: null,
        wanderPauseUntil: 0,
        assignedSeat: seatKey,
        toolHistory: [],
        updatedAt: Date.now(),
      };
      this.villagers.set(key, v);
    } else if (name) {
      v.name = name;
    }
    this._emit();
    this.log('info', `${v.name} arrived (${VILLAGE_PROFESSIONS[professionKey]?.title || professionKey})`);
    return v;
  }

  removeVillager(key) {
    const v = this.villagers.get(key);
    if (!v) return;
    if (v.assignedSeat && v.professionKey) {
      const prof = VILLAGE_PROFESSIONS[v.professionKey];
      if (prof) {
        const s = this._seatAssignments.get(prof.building);
        if (s) s.delete(key);
      }
    }
    this.villagers.delete(key);
    this._emit();
  }

  classifyTool(toolName) {
    if (!toolName) return null;
    if (READING_TOOLS.has(toolName)) return 'reading';
    if (WRITING_TOOLS.has(toolName)) return 'writing';
    return null;
  }

  addToolEntry(key, tool, args, status, resultSummary) {
    const v = this.villagers.get(key);
    if (!v) return;
    v.toolHistory.push({
      tool,
      args: args ? JSON.stringify(args).slice(0, 120) : '',
      status: status || 'done',
      result: resultSummary ? String(resultSummary).slice(0, 100) : '',
      timestamp: Date.now(),
    });
    if (v.toolHistory.length > 50) v.toolHistory.shift();
    this._emit();
  }

  setStatus(key, status, opts) {
    opts = opts || {};
    const v = this.villagers.get(key);
    if (!v) return;
    clearTimeout(this._idleTimers.get(key));

    v.status = status;
    v.subStatus = opts.subStatus !== undefined ? opts.subStatus : null;
    v.taskText = opts.taskText !== undefined ? opts.taskText : v.taskText;
    v.walkTarget = null;

    if (opts.mood) v.mood = opts.mood;
    else if (status === 'working') v.mood = 'busy';
    else if (status === 'reviewing') v.mood = 'thinking';
    else if (status === 'waiting') v.mood = 'waiting';
    else if (status === 'error') v.mood = 'waiting';
    else if (status === 'finished') v.mood = 'happy';
    else if (status === 'idle') v.mood = 'happy';
    v.updatedAt = Date.now();

    if (opts.bubble !== undefined) {
      if (opts.bubble === null) this.clearBubble(key);
      else this.setBubble(key, opts.bubble.icon, opts.bubble.text, opts.bubble.duration);
    }

    this._emit();
    const statusLabel = { working: 'started working', meeting: 'entered a meeting', reviewing: 'is reviewing', waiting: 'is waiting', finished: 'finished', error: 'hit an error', idle: 'is now idle' }[status] || status;
    this.log(status === 'error' ? 'error' : status === 'waiting' ? 'warn' : 'log', `${v.name} ${statusLabel}${opts.taskText ? ': ' + opts.taskText : ''}`);

    if (status === 'finished' || status === 'error') {
      const t = setTimeout(() => {
        if (this.villagers.get(key)?.status === status) {
          this.setStatus(key, 'idle', { taskText: '' });
        }
      }, status === 'error' ? 9000 : 5000);
      this._idleTimers.set(key, t);
    }
  }

  setBubble(key, icon, text, durationMs) {
    const v = this.villagers.get(key);
    if (!v) return;
    const expiresAt = durationMs === 0 ? 0 : Date.now() + (durationMs || BUBBLE_AUTO_FADE);
    v.bubble = { icon: icon || '', text: text || '', expiresAt };
    if (durationMs !== 0) {
      clearTimeout(this._bubbleTimers.get(key));
      const timer = setTimeout(() => {
        if (this.villagers.get(key)?.bubble?.expiresAt === expiresAt) {
          this.clearBubble(key);
        }
      }, durationMs || BUBBLE_AUTO_FADE);
      this._bubbleTimers.set(key, timer);
    }
    this._emit();
  }

  clearBubble(key) {
    const v = this.villagers.get(key);
    if (!v) return;
    v.bubble = null;
    clearTimeout(this._bubbleTimers.get(key));
    this._bubbleTimers.delete(key);
    this._emit();
  }

  walkTo(key, x, y, onArrival) {
    const v = this.villagers.get(key);
    if (!v) return;
    v.status = 'walking';
    v.walkTarget = { x, y, onArrival: typeof onArrival === 'function' ? onArrival : null, startedAt: Date.now() };
    v.taskText = '';
    this._emit();
  }

  tickAnimations() {
    const now = Date.now();
    let changed = false;

    for (const [key, v] of this.villagers) {
      if (v.status === 'walking' && v.walkTarget) {
        if (now - v.walkTarget.startedAt >= 900) {
          const cb = v.walkTarget.onArrival;
          v.walkTarget = null;
          v.status = 'idle';
          changed = true;
          if (cb) cb(key);
        }
      }
    }

    if (changed) this._emit();
  }

  // --- Sub-agent support ---

  spawnSubagent(parentKey, name, taskText) {
    const parent = this.villagers.get(parentKey);
    if (!parent) return null;
    const key = `sub-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const v = {
      key,
      name: name || 'Helper',
      professionKey: parent.professionKey,
      status: 'working',
      subStatus: null,
      mood: 'busy',
      taskText: taskText || '',
      bubble: null,
      facing: 'south',
      walkTarget: null,
      wanderPauseUntil: 0,
      assignedSeat: null,
      toolHistory: [],
      isSubagent: true,
      parentKey,
      updatedAt: Date.now(),
    };
    this.villagers.set(key, v);
    this._emit();
    this.log('info', `${v.name} spawned as sub-agent for ${parent.name}: ${taskText}`);
    return v;
  }

  despawnSubagent(key) {
    const v = this.villagers.get(key);
    if (!v || !v.isSubagent) return;
    this.villagers.delete(key);
    this._emit();
  }

  say(key, text) {
    const v = this.villagers.get(key);
    const from = v ? v.name : key;
    const entry = { ts: Date.now(), from, text, key };
    this.feed.push(entry);
    if (this.feed.length > 50) this.feed.shift();
    this._emit();
    this.log('log', `${from}: ${text.slice(0, 120)}`);
    return entry;
  }

  log(level, message) {
    const entry = { ts: Date.now(), level: level || 'log', message: String(message) };
    this.consoleEntries.push(entry);
    if (this.consoleEntries.length > 200) this.consoleEntries.shift();
    this._emit();
    return entry;
  }

  messenger(fromKey, toKey, text) {
    const id = 'msg-' + Date.now() + Math.random().toString(36).slice(2, 7);
    this.messengers.push({ id, fromKey, toKey, spawnedAt: Date.now() });
    if (text) this.say(fromKey, text);
    this._emit();
    setTimeout(() => {
      this.messengers = this.messengers.filter((m) => m.id !== id);
      this._emit();
    }, 2600);
    return id;
  }
}

module.exports = { VillageStore };
