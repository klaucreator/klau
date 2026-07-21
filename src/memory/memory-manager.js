'use strict';

/**
 * MemoryManager — short-term / session / long-term memory for an agent or assistant.
 *
 * Owns exactly one thing: storing, searching, and forgetting "memory items" (facts,
 * messages, summaries — any small piece of content worth remembering) across three tiers:
 *
 *   - short-term  A capped, most-recent-first buffer. No session concept. The oldest item
 *                 is evicted once the buffer is full. Good for "last N turns of context".
 *   - session     Items scoped to a `sessionId` (e.g. one conversation/chat). Cleared, or
 *                 selectively promoted to long-term, via `endSession`.
 *   - long-term   Durable-ish storage behind a small, swappable `LongTermMemoryStore`
 *                 interface (see below). Ships with an in-memory default; a caller can
 *                 supply anything that implements the interface — a JSON file on disk, an
 *                 Obsidian vault file, a database, a vector store — MemoryManager itself
 *                 never knows or cares which.
 *
 * Deliberately provider-independent: this file has no dependency on Obsidian, on any AI
 * provider (Anthropic, OpenAI, or otherwise), or on any specific persistence backend. It has
 * no upward dependencies, same as `core/event-bus.js` and `tasks/task-manager.js` — it can be
 * `require`d from anywhere.
 *
 * Deliberately out of scope (by design, not omission):
 * - Deciding *what* is worth remembering, or summarizing/compressing content — that's a
 *   caller/agent concern. MemoryManager stores whatever it's given.
 * - Calling out to an AI provider (e.g. for embeddings or summarization).
 * - Any UI rendering.
 *
 * @example
 * const { MemoryManager } = require('./memory/memory-manager');
 * const memory = new MemoryManager({ shortTermLimit: 20 });
 *
 * memory.rememberShortTerm('User prefers dark mode.');
 * memory.rememberSession('chat-42', 'User is planning a trip to Kyoto in October.');
 * memory.rememberLongTerm('User\'s name is Priya.', { tags: ['profile'], importance: 0.9 });
 *
 * memory.search('Kyoto'); // -> matching items across all tiers, most relevant first
 *
 * // Persist to disk (or wherever) as plain JSON:
 * const json = memory.exportJSON();
 * // ...later, in a new process...
 * const restored = MemoryManager.fromJSON(JSON.parse(json));
 *
 * @example
 * // Swap in a custom long-term backend (still no provider dependency here) by implementing
 * // the LongTermMemoryStore interface: add, get, list, update, delete, clear, toJSON, fromJSON.
 * const fileBackedStore = new MyJsonFileStore('./memory.json');
 * const memory = new MemoryManager({ longTermStore: fileBackedStore });
 */

/** @type {Readonly<Record<string, string>>} */
const MEMORY_TIER = Object.freeze({
  SHORT_TERM: 'short-term',
  SESSION: 'session',
  LONG_TERM: 'long-term',
});

const ALL_TIERS = Object.freeze([MEMORY_TIER.SHORT_TERM, MEMORY_TIER.SESSION, MEMORY_TIER.LONG_TERM]);

const JSON_FORMAT_VERSION = 1;

/**
 * Error type for every failure MemoryManager raises itself (invalid input, unknown id,
 * an unusable long-term store). Lets callers `catch (e) { if (e.code === 'NOT_FOUND') ... }`
 * instead of string-matching messages.
 */
class MemoryManagerError extends Error {
  constructor(message, code, details) {
    super(message);
    this.name = 'MemoryManagerError';
    this.code = code || 'MEMORY_MANAGER_ERROR';
    if (details) this.details = details;
  }
}

/**
 * RFC 4122 v4 UUID. Prefers the platform's `crypto.randomUUID()`; falls back to a
 * `Math.random()`-based generator so this still works on runtimes where that global is
 * missing. Good enough for memory ids — not used for anything security-sensitive.
 * @returns {string}
 */
function generateId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * @typedef {object} MemoryItem
 * @property {string} id
 * @property {'short-term'|'session'|'long-term'} tier
 * @property {string|null} sessionId Set only for `session`-tier items.
 * @property {*} content Arbitrary caller-defined content (a string, or any JSON-serializable
 *   value). MemoryManager never inspects its shape beyond stringifying it for search.
 * @property {string[]} tags
 * @property {number} importance 0–1. Purely advisory — used as a tie-breaker in search
 *   ranking and as a default filter for `endSession({ promote: true })`.
 * @property {Record<string, any>} metadata Arbitrary caller-defined data.
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {number|null} expiresAt If set, the item is treated as gone once `now() >=
 *   expiresAt` (lazily purged on read). Mainly useful for short-term/session items.
 */

/**
 * The interface a long-term memory backend must implement. MemoryManager only ever calls
 * these eight methods — anything satisfying this shape can be passed as `options.longTermStore`
 * (an in-memory Map, a JSON file on disk, an Obsidian vault file, a database, a vector store
 * with a `list`/`search` shim, etc). `InMemoryLongTermStore` below is the default.
 *
 * @typedef {object} LongTermMemoryStore
 * @property {(item: MemoryItem) => MemoryItem} add
 * @property {(id: string) => MemoryItem|null} get
 * @property {() => MemoryItem[]} list
 * @property {(id: string, patch: Partial<MemoryItem>) => MemoryItem|null} update
 * @property {(id: string) => boolean} delete
 * @property {() => void} clear
 * @property {() => MemoryItem[]} toJSON
 * @property {(items: MemoryItem[]) => void} fromJSON
 */

const LONG_TERM_STORE_METHODS = ['add', 'get', 'list', 'update', 'delete', 'clear', 'toJSON', 'fromJSON'];

/**
 * Default, provider-independent `LongTermMemoryStore`: keeps items in a `Map`. Not actually
 * "long-term" on its own (it disappears when the process exits) — pair it with
 * `MemoryManager#exportJSON` / `importJSON` for real persistence, or swap in a store backed
 * by disk/a database instead.
 * @implements {LongTermMemoryStore}
 */
class InMemoryLongTermStore {
  constructor() {
    /** @type {Map<string, MemoryItem>} */
    this._items = new Map();
  }

  add(item) {
    this._items.set(item.id, item);
    return item;
  }

  get(id) {
    return this._items.get(id) || null;
  }

  list() {
    return Array.from(this._items.values());
  }

  update(id, patch) {
    const item = this._items.get(id);
    if (!item) return null;
    Object.assign(item, patch);
    return item;
  }

  delete(id) {
    return this._items.delete(id);
  }

  clear() {
    this._items.clear();
  }

  toJSON() {
    return Array.from(this._items.values());
  }

  fromJSON(items) {
    this._items.clear();
    for (const item of items || []) {
      this._items.set(item.id, item);
    }
  }
}

class MemoryManager {
  /**
   * @param {object} [options]
   * @param {import('../core/event-bus').EventBus} [options.eventBus]
   *   If provided, memory changes are published on it (`memory:remembered`,
   *   `memory:evicted`, `memory:forgotten`, `memory:promoted`, `memory:sessionEnded`,
   *   `memory:cleared`, `memory:loaded`), each with a small payload. Entirely optional.
   * @param {LongTermMemoryStore} [options.longTermStore] Defaults to `InMemoryLongTermStore`.
   *   Must implement the `LongTermMemoryStore` interface (checked at construction time).
   * @param {number} [options.shortTermLimit] Max items kept in short-term memory (default 50).
   *   Oldest is evicted once exceeded.
   * @param {number} [options.sessionLimit] Max items kept per session (default: unlimited).
   * @param {() => number} [options.now] Clock override, mainly for tests.
   * @param {() => string} [options.idFactory] Id generator override, mainly for tests.
   */
  constructor(options) {
    options = options || {};
    this._now = typeof options.now === 'function' ? options.now : () => Date.now();
    this._generateId = typeof options.idFactory === 'function' ? options.idFactory : generateId;
    this._events = options.eventBus || null;
    this._shortTermLimit = Number.isFinite(options.shortTermLimit) ? options.shortTermLimit : 50;
    this._sessionLimit = Number.isFinite(options.sessionLimit) ? options.sessionLimit : Infinity;

    /** @type {MemoryItem[]} Most-recent-last. */
    this._shortTerm = [];
    /** @type {Map<string, MemoryItem[]>} sessionId -> items, most-recent-last. */
    this._sessions = new Map();

    this._longTerm = options.longTermStore || new InMemoryLongTermStore();
    this._assertValidStore(this._longTerm);
  }

  // ---------------------------------------------------------------------------------------
  // Remember (write)
  // ---------------------------------------------------------------------------------------

  /**
   * Generic write. Prefer `rememberShortTerm` / `rememberSession` / `rememberLongTerm` for
   * clarity; this is what they all call into.
   * @param {object} input
   * @param {'short-term'|'session'|'long-term'} [input.tier] Defaults to `short-term`.
   * @param {*} input.content Required. Any JSON-serializable value (or a string).
   * @param {string} [input.sessionId] Required when `tier` is `session`.
   * @param {string[]} [input.tags]
   * @param {number} [input.importance] 0–1, default 0.5.
   * @param {Record<string, any>} [input.metadata]
   * @param {number} [input.ttlMs] If set, the item expires `ttlMs` after creation.
   * @returns {MemoryItem} The stored item (a defensive copy).
   */
  remember(input) {
    input = input || {};
    if (input.content === undefined || input.content === null) {
      throw new MemoryManagerError('content is required to remember something', 'INVALID_INPUT');
    }
    const tier = input.tier || MEMORY_TIER.SHORT_TERM;
    if (!ALL_TIERS.includes(tier)) {
      throw new MemoryManagerError(`unknown tier "${tier}"`, 'INVALID_INPUT', { tier });
    }
    if (tier === MEMORY_TIER.SESSION && !input.sessionId) {
      throw new MemoryManagerError('sessionId is required for session-tier memory', 'INVALID_INPUT');
    }

    const at = this._now();
    const item = {
      id: this._generateId(),
      tier,
      sessionId: tier === MEMORY_TIER.SESSION ? input.sessionId : null,
      content: input.content,
      tags: Array.isArray(input.tags) ? input.tags.slice() : [],
      importance: this._clampImportance(input.importance),
      metadata: input.metadata && typeof input.metadata === 'object' ? { ...input.metadata } : {},
      createdAt: at,
      updatedAt: at,
      expiresAt: Number.isFinite(input.ttlMs) ? at + input.ttlMs : null,
    };

    let evicted = null;
    if (tier === MEMORY_TIER.SHORT_TERM) {
      this._shortTerm.push(item);
      if (this._shortTerm.length > this._shortTermLimit) {
        evicted = this._shortTerm.shift();
      }
    } else if (tier === MEMORY_TIER.SESSION) {
      const bucket = this._sessions.get(item.sessionId) || [];
      bucket.push(item);
      if (bucket.length > this._sessionLimit) {
        evicted = bucket.shift();
      }
      this._sessions.set(item.sessionId, bucket);
    } else {
      this._longTerm.add(item);
    }

    this._emit('memory:remembered', { item: this._clone(item) });
    if (evicted) this._emit('memory:evicted', { item: this._clone(evicted) });
    return this._clone(item);
  }

  /**
   * @param {*} content
   * @param {object} [opts] Same options as `remember` minus `tier`/`sessionId`.
   * @returns {MemoryItem}
   */
  rememberShortTerm(content, opts) {
    return this.remember({ ...(opts || {}), tier: MEMORY_TIER.SHORT_TERM, content });
  }

  /**
   * @param {string} sessionId
   * @param {*} content
   * @param {object} [opts] Same options as `remember` minus `tier`/`sessionId`.
   * @returns {MemoryItem}
   */
  rememberSession(sessionId, content, opts) {
    return this.remember({ ...(opts || {}), tier: MEMORY_TIER.SESSION, sessionId, content });
  }

  /**
   * @param {*} content
   * @param {object} [opts] Same options as `remember` minus `tier`/`sessionId`.
   * @returns {MemoryItem}
   */
  rememberLongTerm(content, opts) {
    return this.remember({ ...(opts || {}), tier: MEMORY_TIER.LONG_TERM, content });
  }

  // ---------------------------------------------------------------------------------------
  // Read
  // ---------------------------------------------------------------------------------------

  /**
   * @param {string} id
   * @returns {MemoryItem|null} A defensive copy, or `null` if not found (or expired).
   */
  recall(id) {
    const item = this._findLive(id);
    return item ? this._clone(item) : null;
  }

  /** Alias of `recall`. */
  get(id) {
    return this.recall(id);
  }

  /**
   * @param {object} [filter]
   * @param {'short-term'|'session'|'long-term'|Array<'short-term'|'session'|'long-term'>} [filter.tier]
   *   Defaults to all tiers.
   * @param {string} [filter.sessionId] Only meaningful for the `session` tier.
   * @param {string[]} [filter.tags] Items must include at least one of these tags.
   * @param {number} [filter.since] Only items created at/after this timestamp.
   * @param {number} [filter.until] Only items created at/before this timestamp.
   * @param {number} [filter.limit] Cap the number of results, most-recent-first.
   * @returns {MemoryItem[]} Defensive copies, most-recent-first.
   */
  list(filter) {
    filter = filter || {};
    this._purgeExpired();
    const tiers = filter.tier ? (Array.isArray(filter.tier) ? filter.tier : [filter.tier]) : ALL_TIERS;
    let results = [];
    for (const tier of tiers) {
      results = results.concat(this._itemsForTier(tier, filter.sessionId));
    }
    results = results.filter((item) => this._matchesFilter(item, filter));
    results.sort((a, b) => b.createdAt - a.createdAt);
    if (Number.isFinite(filter.limit)) results = results.slice(0, filter.limit);
    return results.map((item) => this._clone(item));
  }

  /**
   * Search across memory by simple text/tag relevance. No embeddings, no AI provider — just
   * word-overlap against stringified content plus a tag match bonus, ranked with a small
   * recency/importance tie-break. Good enough for "find what's relevant" without depending
   * on anything external; swap in a smarter `longTermStore` (e.g. one backed by a vector DB)
   * if you need semantic search over long-term memory specifically.
   * @param {string} query
   * @param {object} [opts]
   * @param {'short-term'|'session'|'long-term'|Array<string>} [opts.tier] Defaults to all tiers.
   * @param {string} [opts.sessionId]
   * @param {string[]} [opts.tags]
   * @param {number} [opts.since]
   * @param {number} [opts.until]
   * @param {number} [opts.limit] Default 20.
   * @param {number} [opts.minScore] Drop results scoring at/below this (default 0 — no match).
   * @returns {(MemoryItem & { score: number })[]} Most relevant first.
   */
  search(query, opts) {
    opts = opts || {};
    const q = typeof query === 'string' ? query.trim() : '';
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    const candidates = this.list({
      tier: opts.tier,
      sessionId: opts.sessionId,
      tags: opts.tags,
      since: opts.since,
      until: opts.until,
    });

    const minScore = Number.isFinite(opts.minScore) ? opts.minScore : 0;
    const scored = candidates
      .map((item) => ({ item, score: this._score(item, terms) }))
      .filter(({ score }) => (terms.length === 0 ? true : score > minScore));

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.item.importance !== a.item.importance) return b.item.importance - a.item.importance;
      return b.item.createdAt - a.item.createdAt;
    });

    const limit = Number.isFinite(opts.limit) ? opts.limit : 20;
    return scored.slice(0, limit).map(({ item, score }) => ({ ...item, score }));
  }

  // ---------------------------------------------------------------------------------------
  // Delete
  // ---------------------------------------------------------------------------------------

  /**
   * Remove a single item by id, wherever it lives.
   * @param {string} id
   * @returns {boolean} Whether an item was actually removed.
   */
  forget(id) {
    for (const tier of ALL_TIERS) {
      const removed = this._removeFromTier(tier, id);
      if (removed) {
        this._emit('memory:forgotten', { item: this._clone(removed) });
        return true;
      }
    }
    return false;
  }

  /** Alias of `forget`. */
  delete(id) {
    return this.forget(id);
  }

  /** Drop everything in short-term memory. */
  clearShortTerm() {
    this._shortTerm = [];
    this._emit('memory:cleared', { tier: MEMORY_TIER.SHORT_TERM });
  }

  /**
   * Drop everything for one session (or every session if `sessionId` is omitted).
   * @param {string} [sessionId]
   */
  clearSession(sessionId) {
    if (sessionId === undefined) {
      this._sessions.clear();
    } else {
      this._sessions.delete(sessionId);
    }
    this._emit('memory:cleared', { tier: MEMORY_TIER.SESSION, sessionId: sessionId ?? null });
  }

  /** Drop everything in the long-term store. */
  clearLongTerm() {
    this._longTerm.clear();
    this._emit('memory:cleared', { tier: MEMORY_TIER.LONG_TERM });
  }

  /** Drop everything, across all three tiers. */
  clearAll() {
    this.clearShortTerm();
    this.clearSession();
    this.clearLongTerm();
  }

  // ---------------------------------------------------------------------------------------
  // Session lifecycle / promotion
  // ---------------------------------------------------------------------------------------

  /**
   * Move an item from short-term or session memory into the long-term store. The original
   * is removed from its source tier; a new item (new id, `tier: 'long-term'`) is created in
   * long-term memory.
   * @param {string} id
   * @param {object} [opts]
   * @param {Record<string, any>} [opts.metadata] Shallow-merged into the promoted item's metadata.
   * @param {string[]} [opts.tags] Replaces the item's tags if provided.
   * @returns {MemoryItem} The new long-term item.
   */
  promote(id, opts) {
    opts = opts || {};
    let source = null;
    let sourceTier = null;
    for (const tier of [MEMORY_TIER.SHORT_TERM, MEMORY_TIER.SESSION]) {
      const removed = this._removeFromTier(tier, id);
      if (removed) {
        source = removed;
        sourceTier = tier;
        break;
      }
    }
    if (!source) {
      throw new MemoryManagerError(
        `no short-term or session item found with id "${id}" to promote`,
        'NOT_FOUND',
        { id }
      );
    }
    const promoted = this.rememberLongTerm(source.content, {
      tags: opts.tags || source.tags,
      importance: source.importance,
      metadata: opts.metadata ? { ...source.metadata, ...opts.metadata } : source.metadata,
    });
    this._emit('memory:promoted', { from: sourceTier, item: promoted });
    return promoted;
  }

  /**
   * End a session: optionally promote some or all of its items to long-term, then clear it.
   * @param {string} sessionId
   * @param {object} [opts]
   * @param {boolean|((item: MemoryItem) => boolean)} [opts.promote] `true` promotes every
   *   item in the session; a function is called per-item to decide (e.g. `(i) => i.importance
   *   >= 0.7`). Defaults to `false` (just clear, nothing carried forward).
   * @returns {MemoryItem[]} Items promoted to long-term (empty if `opts.promote` was falsy).
   */
  endSession(sessionId, opts) {
    opts = opts || {};
    const items = this._sessions.get(sessionId) || [];
    const promoted = [];
    if (opts.promote) {
      const shouldPromote = typeof opts.promote === 'function' ? opts.promote : () => true;
      for (const item of items.slice()) {
        if (shouldPromote(this._clone(item))) {
          promoted.push(this.promote(item.id));
        }
      }
    }
    this._sessions.delete(sessionId);
    this._emit('memory:sessionEnded', { sessionId, promotedCount: promoted.length });
    return promoted;
  }

  // ---------------------------------------------------------------------------------------
  // Save / load (JSON)
  // ---------------------------------------------------------------------------------------

  /**
   * @returns {object} Plain-object snapshot of everything MemoryManager holds (short-term,
   *   every session, and the long-term store's own `toJSON()`). Safe to `JSON.stringify`.
   */
  toJSON() {
    this._purgeExpired();
    const sessions = {};
    for (const [sessionId, items] of this._sessions.entries()) {
      sessions[sessionId] = items.map((item) => this._clone(item));
    }
    return {
      version: JSON_FORMAT_VERSION,
      shortTerm: this._shortTerm.map((item) => this._clone(item)),
      sessions,
      longTerm: this._longTerm.toJSON(),
    };
  }

  /** @returns {string} `JSON.stringify(this.toJSON())`. */
  exportJSON(indent) {
    return JSON.stringify(this.toJSON(), null, indent === undefined ? 2 : indent);
  }

  /**
   * Replace all current state with a previously-saved snapshot (from `toJSON`/`exportJSON`).
   * @param {object} data
   */
  loadJSON(data) {
    data = data || {};
    this._shortTerm = Array.isArray(data.shortTerm) ? data.shortTerm.map((item) => ({ ...item })) : [];
    this._sessions = new Map();
    const sessions = data.sessions && typeof data.sessions === 'object' ? data.sessions : {};
    for (const sessionId of Object.keys(sessions)) {
      this._sessions.set(sessionId, (sessions[sessionId] || []).map((item) => ({ ...item })));
    }
    this._longTerm.clear();
    this._longTerm.fromJSON(Array.isArray(data.longTerm) ? data.longTerm : []);
    this._emit('memory:loaded', {});
  }

  /** @param {string} json A string previously produced by `exportJSON`. */
  importJSON(json) {
    let data;
    try {
      data = JSON.parse(json);
    } catch (e) {
      throw new MemoryManagerError('importJSON received invalid JSON', 'INVALID_INPUT', { cause: e.message });
    }
    this.loadJSON(data);
  }

  /**
   * @param {object} data A snapshot from `toJSON`.
   * @param {object} [options] Same constructor options as `new MemoryManager(...)`.
   * @returns {MemoryManager}
   */
  static fromJSON(data, options) {
    const manager = new MemoryManager(options);
    manager.loadJSON(data);
    return manager;
  }

  // ---------------------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------------------

  _assertValidStore(store) {
    const missing = LONG_TERM_STORE_METHODS.filter((m) => typeof store[m] !== 'function');
    if (missing.length) {
      throw new MemoryManagerError(
        `longTermStore is missing required method(s): ${missing.join(', ')}`,
        'INVALID_STORE',
        { missing }
      );
    }
  }

  _clampImportance(value) {
    if (!Number.isFinite(value)) return 0.5;
    return Math.max(0, Math.min(1, value));
  }

  _itemsForTier(tier, sessionId) {
    if (tier === MEMORY_TIER.SHORT_TERM) return this._shortTerm.slice();
    if (tier === MEMORY_TIER.LONG_TERM) return this._longTerm.list().slice();
    if (tier === MEMORY_TIER.SESSION) {
      if (sessionId !== undefined) return (this._sessions.get(sessionId) || []).slice();
      let all = [];
      for (const items of this._sessions.values()) all = all.concat(items);
      return all;
    }
    return [];
  }

  _matchesFilter(item, filter) {
    if (filter.sessionId !== undefined && item.tier === MEMORY_TIER.SESSION && item.sessionId !== filter.sessionId) {
      return false;
    }
    if (filter.tags && filter.tags.length && !filter.tags.some((t) => item.tags.includes(t))) {
      return false;
    }
    if (Number.isFinite(filter.since) && item.createdAt < filter.since) return false;
    if (Number.isFinite(filter.until) && item.createdAt > filter.until) return false;
    return true;
  }

  /** Word-overlap + tag-match score against a lowercased term list. 0 = no match. */
  _score(item, terms) {
    if (terms.length === 0) return 1;
    const haystack = (
      (typeof item.content === 'string' ? item.content : JSON.stringify(item.content)) +
      ' ' +
      item.tags.join(' ')
    ).toLowerCase();
    let matches = 0;
    for (const term of terms) {
      if (haystack.includes(term)) matches += 1;
    }
    if (matches === 0) return 0;
    const tagBonus = item.tags.some((t) => terms.includes(t.toLowerCase())) ? 0.5 : 0;
    return matches / terms.length + tagBonus;
  }

  _findLive(id) {
    for (const tier of ALL_TIERS) {
      const item = this._itemsForTier(tier).find((i) => i.id === id);
      if (item && !this._isExpired(item)) return item;
    }
    return null;
  }

  _removeFromTier(tier, id) {
    if (tier === MEMORY_TIER.SHORT_TERM) {
      const idx = this._shortTerm.findIndex((i) => i.id === id);
      if (idx === -1) return null;
      return this._shortTerm.splice(idx, 1)[0];
    }
    if (tier === MEMORY_TIER.SESSION) {
      for (const [sessionId, items] of this._sessions.entries()) {
        const idx = items.findIndex((i) => i.id === id);
        if (idx !== -1) {
          const [removed] = items.splice(idx, 1);
          if (items.length === 0) this._sessions.delete(sessionId);
          return removed;
        }
      }
      return null;
    }
    if (tier === MEMORY_TIER.LONG_TERM) {
      const item = this._longTerm.get(id);
      if (!item) return null;
      this._longTerm.delete(id);
      return item;
    }
    return null;
  }

  _isExpired(item) {
    return Number.isFinite(item.expiresAt) && this._now() >= item.expiresAt;
  }

  /** Lazily drop expired short-term/session items. Long-term items don't auto-expire. */
  _purgeExpired() {
    const now = this._now();
    this._shortTerm = this._shortTerm.filter((i) => !Number.isFinite(i.expiresAt) || now < i.expiresAt);
    for (const [sessionId, items] of this._sessions.entries()) {
      const kept = items.filter((i) => !Number.isFinite(i.expiresAt) || now < i.expiresAt);
      if (kept.length === 0) this._sessions.delete(sessionId);
      else this._sessions.set(sessionId, kept);
    }
  }

  /** Shallow-safe copy so callers can't mutate internal state through a returned item. */
  _clone(item) {
    return {
      ...item,
      tags: item.tags.slice(),
      metadata: { ...item.metadata },
    };
  }

  _emit(event, payload) {
    if (!this._events) return;
    try {
      this._events.emit(event, payload);
    } catch (e) {
      // Never let a broken event bus / listener break memory state changes.
    }
  }
}

module.exports = { MemoryManager, MemoryManagerError, MEMORY_TIER, InMemoryLongTermStore };
