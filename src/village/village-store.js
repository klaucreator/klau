'use strict';

const { VILLAGE_PROFESSIONS } = require('./village-roster');

/**
 * Central store for "the village is alive" state. Views (chat, organize, agent) call into
 * this as they work; the VillageView subscribes and renders whatever it currently holds.
 * Deliberately dumb/synchronous — it just tracks state and keeps a short activity feed.
 * Nothing here is persisted to disk; it resets whenever Obsidian restarts.
 */
class VillageStore {
  constructor(plugin) {
    this.plugin = plugin;
    this.villagers = new Map();
    this.feed = [];
    this.consoleEntries = [];
    this.messengers = [];
    this.listeners = new Set();
    this._idleTimers = new Map();
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

  ensure(key, professionKey, name) {
    if (!VILLAGE_PROFESSIONS[professionKey]) professionKey = 'mayor';
    let v = this.villagers.get(key);
    if (!v) {
      v = {
        key,
        name: name || VILLAGE_PROFESSIONS[professionKey].title,
        professionKey,
        status: 'idle',
        mood: 'happy',
        taskText: '',
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

  setStatus(key, status, opts) {
    opts = opts || {};
    const v = this.villagers.get(key);
    if (!v) return;
    clearTimeout(this._idleTimers.get(key));
    v.status = status;
    v.taskText = opts.taskText !== undefined ? opts.taskText : v.taskText;
    if (opts.mood) v.mood = opts.mood;
    else if (status === 'working') v.mood = 'busy';
    else if (status === 'reviewing') v.mood = 'thinking';
    else if (status === 'waiting') v.mood = 'waiting';
    else if (status === 'error') v.mood = 'waiting';
    else if (status === 'finished') v.mood = 'happy';
    else if (status === 'idle') v.mood = 'happy';
    v.updatedAt = Date.now();
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
