'use strict';

/**
 * A small publish/subscribe event bus.
 *
 * Any module can `require` this file, create (or receive) an `EventBus` instance, and use it
 * to talk to other modules without importing them directly — the same role `VillageStore`
 * already plays for village state, generalized for arbitrary events. It has no dependency on
 * Obsidian or on any other module in this plugin, so it can be used from `core/`, `providers/`,
 * `agents/`, `tools/`, `workflow/`, `memory/`, or `ui/` alike.
 *
 * Design notes:
 * - `on`/`once` return an unsubscribe function (same convention as `VillageStore.subscribe`),
 *   so callers don't need to keep the original listener reference around just to remove it.
 * - `emit` supports both sync and async listeners. It always returns a Promise that resolves
 *   once every listener has settled, so callers that care about completion (e.g. "wait for all
 *   handlers of this event before continuing") can `await` it; callers that don't care can just
 *   call `emit(...)` without awaiting.
 * - A listener that throws (or whose returned promise rejects) never breaks other listeners or
 *   the emitter itself — errors are caught per-listener and reported via `onListenerError`
 *   (default: `console.error`), the same "don't let one bad handler take down the rest"
 *   philosophy `VillageStore._emit` already uses.
 *
 * @template {Record<string, any>} [EventMap=Record<string, any>]
 *
 * @example
 * const { EventBus } = require('./core/event-bus');
 * const bus = new EventBus();
 *
 * // Any module can subscribe...
 * const unsubscribe = bus.on('agent:step', (payload) => {
 *   console.log('step', payload.stepNumber, 'of', payload.maxSteps);
 * });
 *
 * // ...and any module can publish, with no knowledge of who (if anyone) is listening.
 * await bus.emit('agent:step', { stepNumber: 1, maxSteps: 20 });
 *
 * // Stop listening whenever you're done (e.g. in a view's onClose()).
 * unsubscribe();
 */
class EventBus {
  /**
   * @param {object} [options]
   * @param {(error: unknown, event: string) => void} [options.onListenerError]
   *   Called whenever a listener throws or its returned promise rejects. Defaults to logging
   *   via `console.error`. Errors are always isolated to the listener that caused them — they
   *   never propagate out of `emit()` and never stop other listeners from running.
   */
  constructor(options) {
    options = options || {};
    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map();
    this._onListenerError =
      typeof options.onListenerError === 'function'
        ? options.onListenerError
        : (err, event) => console.error(`[EventBus] listener error for "${event}":`, err);
  }

  /**
   * Subscribe to an event. Multiple listeners on the same event are all called, in the order
   * they were added.
   *
   * @template {keyof EventMap & string} K
   * @param {K} event
   * @param {(payload: EventMap[K], event: K) => void | Promise<void>} listener
   * @returns {() => void} Call to remove this listener (equivalent to `off(event, listener)`).
   */
  on(event, listener) {
    if (typeof event !== 'string' || !event) {
      throw new TypeError('EventBus.on: event must be a non-empty string');
    }
    if (typeof listener !== 'function') {
      throw new TypeError('EventBus.on: listener must be a function');
    }
    let set = this._listeners.get(event);
    if (!set) {
      set = new Set();
      this._listeners.set(event, set);
    }
    set.add(listener);
    return () => this.off(event, listener);
  }

  /**
   * Subscribe to an event for exactly one emission, then automatically unsubscribe.
   *
   * @template {keyof EventMap & string} K
   * @param {K} event
   * @param {(payload: EventMap[K], event: K) => void | Promise<void>} listener
   * @returns {() => void} Call to cancel before it fires.
   */
  once(event, listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('EventBus.once: listener must be a function');
    }
    const wrapper = (payload, evt) => {
      this.off(event, wrapper);
      return listener(payload, evt);
    };
    return this.on(event, wrapper);
  }

  /**
   * Remove a previously-added listener. Safe to call even if the listener was already removed
   * or never added — just returns `false` in that case.
   *
   * @template {keyof EventMap & string} K
   * @param {K} event
   * @param {Function} listener
   * @returns {boolean} Whether a listener was actually removed.
   */
  off(event, listener) {
    const set = this._listeners.get(event);
    if (!set) return false;
    const removed = set.delete(listener);
    if (set.size === 0) this._listeners.delete(event);
    return removed;
  }

  /**
   * Remove every listener for a given event, or every listener for every event if no event is
   * given. Useful in teardown (e.g. a view's `onClose()`) if individual unsubscribe functions
   * weren't kept around.
   *
   * @param {string} [event]
   */
  removeAllListeners(event) {
    if (event === undefined) {
      this._listeners.clear();
      return;
    }
    this._listeners.delete(event);
  }

  /**
   * @param {string} event
   * @returns {number} How many listeners are currently subscribed to this event.
   */
  listenerCount(event) {
    const set = this._listeners.get(event);
    return set ? set.size : 0;
  }

  /**
   * @returns {string[]} Every event name that currently has at least one listener.
   */
  eventNames() {
    return Array.from(this._listeners.keys());
  }

  /**
   * Publish an event. Every current listener for `event` is called with `payload`; listeners
   * may be synchronous or return a Promise (`async` functions work directly). All listeners run
   * even if one of them throws or rejects — failures are isolated and reported individually via
   * `onListenerError`, never thrown back at the caller of `emit`.
   *
   * The returned Promise resolves once every listener has settled (with `Promise.allSettled`
   * results), which is handy if a caller wants to know "has everyone finished handling this?"
   * before moving on. Most callers can simply ignore the return value and not await it —
   * `emit()` never rejects.
   *
   * @template {keyof EventMap & string} K
   * @param {K} event
   * @param {EventMap[K]} [payload]
   * @returns {Promise<PromiseSettledResult<any>[]>}
   */
  async emit(event, payload) {
    const set = this._listeners.get(event);
    if (!set || set.size === 0) return [];
    // Snapshot the listener list so a listener that subscribes/unsubscribes mid-emit doesn't
    // change which listeners this particular emit() call reaches.
    const listeners = Array.from(set);
    const results = await Promise.allSettled(
      listeners.map((listener) => {
        try {
          return Promise.resolve(listener(payload, event));
        } catch (err) {
          return Promise.reject(err);
        }
      })
    );
    for (const result of results) {
      if (result.status === 'rejected') {
        try {
          this._onListenerError(result.reason, event);
        } catch (e) {
          // Never let a broken error handler itself break emit().
        }
      }
    }
    return results;
  }
}

module.exports = { EventBus };
