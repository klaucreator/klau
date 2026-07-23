'use strict';

const { VILLAGE_PROFESSIONS, VILLAGE_BUILDINGS, resolveVillageProfession, skillLevel } = require('./village-roster');

const READING_TOOLS = new Set(['list_files', 'read_note', 'read_notes', 'get_note_metadata', 'search_notes', 'search_web']);
const WRITING_TOOLS = new Set(['write_note', 'append_note', 'add_tags', 'move_note', 'rename_note', 'create_folder', 'delete_note']);

const BUBBLE_AUTO_FADE = 2500;
const AUTO_SPAWN_CHECK_MS = 5000;
const MAX_IDLE_BEFORE_DORMANT = 5;
const SPAWN_QUEUE_THRESHOLD = 2;

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
    this._seatAssignments = new Map();
    this.taskQueue = [];
    this._lastSpawnCheck = 0;
    this._spawnCount = 0;
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
        experience: 0,
        completedTasks: [],
        lessons: [],
        updatedAt: Date.now(),
      };
      this.villagers.set(key, v);
      this.log('info', `${v.name} arrived (${VILLAGE_PROFESSIONS[professionKey]?.title || professionKey})`);
    } else if (name) {
      v.name = name;
    }
    this._emit();
    const sl = skillLevel(v.experience);
    this.log('log', `${v.name} ${v.experience > 0 ? `(Lvl ${sl.level} ${sl.title}) ` : ''}ready`);
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
      // Play notification sound
      if (this.plugin && this.plugin.playNotificationSound) {
        this.plugin.playNotificationSound().catch(() => {});
      }
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

    this._checkSpawn();

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

  recordTaskComplete(key, summary) {
    const v = this.villagers.get(key);
    if (!v) return;
    v.experience = (v.experience || 0) + 1;
    const oldLevel = skillLevel(v.experience - 1).level;
    const newLevel = skillLevel(v.experience).level;
    const entry = { summary: String(summary || '').slice(0, 120), completedAt: Date.now() };
    v.completedTasks.push(entry);
    if (v.completedTasks.length > 20) v.completedTasks.shift();
    v.lessons.push(entry.summary);
    if (v.lessons.length > 10) v.lessons = v.lessons.slice(-10);
    if (newLevel > oldLevel) {
      const sl = skillLevel(v.experience);
      this.setBubble(key, '⭐', `Reached ${sl.title}!`, 3000);
      this.log('info', `${v.name} leveled up to ${sl.title} (Lvl ${sl.level})`);
    }
    this._emit();
  }

  getLessons(forKey) {
    const v = this.villagers.get(forKey);
    if (!v || !v.lessons || v.lessons.length === 0) return '';
    return v.lessons.map((l, i) => `${i + 1}. ${l}`).join('\n');
  }

  addTask(goal) {
    const task = { id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`, goal, createdAt: Date.now(), assignedTo: null };
    this.taskQueue.push(task);
    this.log('log', `Task queued: "${goal.slice(0, 60)}" (${this.taskQueue.length} pending)`);
    this._checkSpawn();
    this._emit();
    return task;
  }

  claimNextTask(key) {
    const task = this.taskQueue.find(t => !t.assignedTo);
    if (!task) return null;
    task.assignedTo = key;
    this._emit();
    return task;
  }

  taskQueueLength() { return this.taskQueue.filter(t => !t.assignedTo).length; }

  _checkSpawn() {
    const now = Date.now();
    if (now - this._lastSpawnCheck < AUTO_SPAWN_CHECK_MS) return;
    this._lastSpawnCheck = now;
    const unassigned = this.taskQueue.filter(t => !t.assignedTo).length;
    if (unassigned === 0) return;
    const idleCount = Array.from(this.villagers.values()).filter(v => !v.isSubagent && (v.status === 'idle' || v.status === 'finished')).length;
    if (unassigned > idleCount * SPAWN_QUEUE_THRESHOLD) {
      this._autoSpawnVillager();
    }
  }

  _autoSpawnVillager() {
    const unassigned = this.taskQueue.filter(t => !t.assignedTo);
    if (unassigned.length === 0) return;
    const goal = unassigned[0].goal;
    const profKey = resolveVillageProfession('Auto-spawned', goal);
    const prof = VILLAGE_PROFESSIONS[profKey];
    this._spawnCount++;
    const name = `${prof ? prof.title : 'Villager'} ${String.fromCharCode(65 + (this._spawnCount - 1) % 26)}`;
    const key = `spawn-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
    const building = prof ? VILLAGE_BUILDINGS[prof.building] : null;
    this.ensure(key, profKey, name);
    const v = this.villagers.get(key);
    if (v) {
      this.setBubble(key, '🌱', `Spawned for "${goal.slice(0, 30)}"`, 3000);
      this.log('info', `${name} spawned (${prof?.title || profKey}) — ${this.taskQueue.filter(t => !t.assignedTo).length} tasks queued`);
    }
    this._emit();
    return key;
  }

  toJSON() {
    const villagers = {};
    for (const [key, v] of this.villagers) {
      villagers[key] = {
        name: v.name,
        professionKey: v.professionKey,
        status: v.status,
        subStatus: v.subStatus,
        mood: v.mood,
        taskText: v.taskText,
        facing: v.facing,
        assignedSeat: v.assignedSeat,
        isSubagent: v.isSubagent || false,
        parentKey: v.parentKey || null,
        toolHistory: v.toolHistory.slice(-10),
        experience: v.experience || 0,
        completedTasks: (v.completedTasks || []).slice(-5),
        lessons: (v.lessons || []).slice(-5),
      };
    }
    return { villagers, seatAssignments: Array.from(this._seatAssignments.entries()).map(([bk, s]) => [bk, Array.from(s)]), taskQueue: this.taskQueue.slice(-20) };
  }

  fromJSON(data) {
    if (!data || !data.villagers) return;
    for (const [key, v] of Object.entries(data.villagers)) {
      this.villagers.set(key, {
        key,
        name: v.name,
        professionKey: v.professionKey,
        status: 'idle',
        subStatus: null,
        mood: 'happy',
        taskText: '',
        bubble: null,
        facing: v.facing || 'south',
        walkTarget: null,
        wanderPauseUntil: 0,
        assignedSeat: v.assignedSeat || null,
        toolHistory: v.toolHistory || [],
        isSubagent: v.isSubagent || false,
        parentKey: v.parentKey || null,
        experience: v.experience || 0,
        completedTasks: v.completedTasks || [],
        lessons: v.lessons || [],
        updatedAt: Date.now(),
      });
    }
    if (data.seatAssignments) {
      for (const [bk, keys] of data.seatAssignments) {
        this._seatAssignments.set(bk, new Set(keys));
      }
    }
    this._emit();
  }
}

module.exports = { VillageStore };
