'use strict';

/**
 * TaskManager — in-memory task lifecycle tracking.
 *
 * Owns exactly one thing: the state of a task from creation to a terminal outcome
 * (completed / failed / cancelled), plus the history of how it got there. It has no
 * dependency on Obsidian or on any other module, so it can be required from `core/`,
 * `workflow/`, or anywhere else — the same "no upward dependencies" shape as
 * `memory/village-store.js` and `core/event-bus.js`.
 *
 * Deliberately out of scope (by design, not omission):
 * - Deciding *who* or *what* works on a task, or *when* — that's a routing/agent concern.
 * - Calling out to an AI provider, a tool, or a vault mutation.
 * - Any UI rendering.
 * TaskManager only answers "what is the current state of this task, and how did it get
 * there?" Callers (a future routing/agent layer) drive state forward by calling
 * `assignTask` / `startTask` / `completeTask` / `failTask` / `cancelTask`.
 *
 * @example
 * const { TaskManager, TASK_STATUS } = require('./tasks/task-manager');
 * const tasks = new TaskManager();
 *
 * const task = tasks.createTask({ title: 'Summarize meeting notes' });
 * tasks.assignTask(task.id, 'agent-1');
 * tasks.startTask(task.id);
 * tasks.completeTask(task.id, { summary: '...' });
 *
 * tasks.getTask(task.id).status; // 'completed'
 * tasks.getHistory(task.id);     // full status timeline for this task
 *
 * @example
 * // Optionally wire up an EventBus (see core/event-bus.js) so other modules can react
 * // to task lifecycle changes without TaskManager knowing who's listening.
 * const { EventBus } = require('../core/event-bus');
 * const tasks = new TaskManager({ eventBus: new EventBus() });
 */

/** @type {Readonly<Record<string, string>>} */
const TASK_STATUS = Object.freeze({
  PENDING: 'pending',
  ASSIGNED: 'assigned',
  WORKING: 'working',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

const TERMINAL_STATUSES = new Set([
  TASK_STATUS.COMPLETED,
  TASK_STATUS.FAILED,
  TASK_STATUS.CANCELLED,
]);

/**
 * Which status a task may move to next, keyed by its current status. Anything not listed
 * here (e.g. moving a completed task back to working) is rejected by `_transition`.
 */
const ALLOWED_TRANSITIONS = Object.freeze({
  [TASK_STATUS.PENDING]: [TASK_STATUS.ASSIGNED, TASK_STATUS.WORKING, TASK_STATUS.CANCELLED],
  [TASK_STATUS.ASSIGNED]: [TASK_STATUS.WORKING, TASK_STATUS.PENDING, TASK_STATUS.CANCELLED],
  [TASK_STATUS.WORKING]: [TASK_STATUS.COMPLETED, TASK_STATUS.FAILED, TASK_STATUS.CANCELLED],
  [TASK_STATUS.COMPLETED]: [],
  [TASK_STATUS.FAILED]: [],
  [TASK_STATUS.CANCELLED]: [],
});

/**
 * Error type for every failure TaskManager raises itself (invalid input, unknown id,
 * disallowed status transition). Lets callers `catch (e) { if (e.code === 'NOT_FOUND') ... }`
 * instead of string-matching messages.
 */
class TaskManagerError extends Error {
  constructor(message, code, details) {
    super(message);
    this.name = 'TaskManagerError';
    this.code = code || 'TASK_MANAGER_ERROR';
    if (details) this.details = details;
  }
}

/**
 * RFC 4122 v4 UUID. Prefers the platform's `crypto.randomUUID()` (available in modern
 * Electron/desktop Obsidian and in current mobile webviews); falls back to a
 * `Math.random()`-based generator so this still works on older mobile runtimes where that
 * global may be missing. Good enough for task ids — not used for anything security-sensitive.
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

class TaskManager {
  /**
   * @param {object} [options]
   * @param {import('../core/event-bus').EventBus} [options.eventBus]
   *   If provided, lifecycle changes are published on it (`task:created`, `task:updated`,
   *   `task:assigned`, `task:started`, `task:completed`, `task:failed`, `task:cancelled`),
   *   each with `{ task }`. Entirely optional — TaskManager works standalone.
   * @param {() => number} [options.now] Clock override, mainly for tests.
   * @param {() => string} [options.idFactory] Id generator override, mainly for tests.
   */
  constructor(options) {
    options = options || {};
    /** @type {Map<string, object>} */
    this._tasks = new Map();
    this._events = options.eventBus || null;
    this._now = typeof options.now === 'function' ? options.now : () => Date.now();
    this._generateId = typeof options.idFactory === 'function' ? options.idFactory : generateId;
  }

  // ---------------------------------------------------------------------------------------
  // Create / read
  // ---------------------------------------------------------------------------------------

  /**
   * Create a new task in `pending` status.
   * @param {object} input
   * @param {string} input.title Required, non-empty.
   * @param {string} [input.description]
   * @param {string|null} [input.assigneeId] Optional starting assignee; task still starts
   *   `pending` — use `assignTask` to move it to `assigned`.
   * @param {Record<string, any>} [input.metadata] Arbitrary caller-defined data.
   * @returns {object} The created task (a defensive copy).
   */
  createTask(input) {
    input = input || {};
    if (typeof input.title !== 'string' || !input.title.trim()) {
      throw new TaskManagerError('title is required to create a task', 'INVALID_INPUT');
    }
    const id = this._generateId();
    const at = this._now();
    const task = {
      id,
      title: input.title.trim(),
      description: typeof input.description === 'string' ? input.description : '',
      status: TASK_STATUS.PENDING,
      assigneeId: input.assigneeId != null ? input.assigneeId : null,
      metadata: input.metadata && typeof input.metadata === 'object' ? { ...input.metadata } : {},
      result: null,
      error: null,
      createdAt: at,
      updatedAt: at,
      history: [{ status: TASK_STATUS.PENDING, at, note: 'created' }],
    };
    this._tasks.set(id, task);
    this._emit('task:created', { task: this._clone(task) });
    return this._clone(task);
  }

  /**
   * @param {string} id
   * @returns {object|null} A defensive copy of the task, or `null` if no such task exists.
   */
  getTask(id) {
    const task = this._tasks.get(id);
    return task ? this._clone(task) : null;
  }

  /**
   * @param {object} [filter]
   * @param {string|string[]} [filter.status] One status, or a list of statuses to include.
   * @param {string|null} [filter.assigneeId]
   * @returns {object[]} Defensive copies, in creation order.
   */
  listTasks(filter) {
    filter = filter || {};
    let results = Array.from(this._tasks.values());
    if (filter.status !== undefined) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      results = results.filter((t) => statuses.includes(t.status));
    }
    if (filter.assigneeId !== undefined) {
      results = results.filter((t) => t.assigneeId === filter.assigneeId);
    }
    return results.map((t) => this._clone(t));
  }

  /**
   * @param {string} id
   * @returns {object[]} The full status timeline for this task, oldest first.
   */
  getHistory(id) {
    const task = this._requireTask(id);
    return task.history.map((entry) => ({ ...entry }));
  }

  // ---------------------------------------------------------------------------------------
  // Update (content, not status)
  // ---------------------------------------------------------------------------------------

  /**
   * Update a task's editable fields (title, description, metadata, assigneeId). Does not
   * change `status` — use `assignTask` / `startTask` / `completeTask` / `failTask` /
   * `cancelTask` for that, so every status change goes through transition validation and
   * is recorded consistently in history.
   * @param {string} id
   * @param {object} patch
   * @param {string} [patch.title]
   * @param {string} [patch.description]
   * @param {string|null} [patch.assigneeId]
   * @param {Record<string, any>} [patch.metadata] Shallow-merged into existing metadata.
   * @returns {object} The updated task (a defensive copy).
   */
  updateTask(id, patch) {
    const task = this._requireTask(id);
    patch = patch || {};
    if (this._isTerminal(task.status)) {
      throw new TaskManagerError(
        `cannot update task "${id}" — it is already ${task.status}`,
        'TASK_TERMINAL',
        { id, status: task.status }
      );
    }
    if (patch.title !== undefined) {
      if (typeof patch.title !== 'string' || !patch.title.trim()) {
        throw new TaskManagerError('title must be a non-empty string', 'INVALID_INPUT');
      }
      task.title = patch.title.trim();
    }
    if (patch.description !== undefined) {
      task.description = typeof patch.description === 'string' ? patch.description : task.description;
    }
    if (patch.assigneeId !== undefined) {
      task.assigneeId = patch.assigneeId;
    }
    if (patch.metadata !== undefined && patch.metadata && typeof patch.metadata === 'object') {
      task.metadata = { ...task.metadata, ...patch.metadata };
    }
    task.updatedAt = this._now();
    task.history.push({ status: task.status, at: task.updatedAt, note: 'updated' });
    this._emit('task:updated', { task: this._clone(task) });
    return this._clone(task);
  }

  // ---------------------------------------------------------------------------------------
  // Status transitions
  // ---------------------------------------------------------------------------------------

  /**
   * Move a task to `assigned` and record who it's assigned to.
   * Allowed from: `pending`, `assigned` (re-assign).
   * @param {string} id
   * @param {string} assigneeId
   * @returns {object} The updated task.
   */
  assignTask(id, assigneeId) {
    if (!assigneeId) {
      throw new TaskManagerError('assigneeId is required to assign a task', 'INVALID_INPUT');
    }
    const task = this._transition(id, TASK_STATUS.ASSIGNED, {
      patch: { assigneeId },
      note: `assigned to ${assigneeId}`,
    });
    this._emit('task:assigned', { task: this._clone(task) });
    return this._clone(task);
  }

  /**
   * Move a task to `working`. Allowed from: `pending`, `assigned`.
   * @param {string} id
   * @returns {object} The updated task.
   */
  startTask(id) {
    const task = this._transition(id, TASK_STATUS.WORKING, { note: 'work started' });
    this._emit('task:started', { task: this._clone(task) });
    return this._clone(task);
  }

  /**
   * Move a task to `completed`. Allowed from: `working`. Terminal.
   * @param {string} id
   * @param {*} [result] Arbitrary caller-defined result payload, stored on the task.
   * @returns {object} The updated task.
   */
  completeTask(id, result) {
    const task = this._transition(id, TASK_STATUS.COMPLETED, {
      patch: { result: result !== undefined ? result : null },
      note: 'completed',
    });
    this._emit('task:completed', { task: this._clone(task) });
    return this._clone(task);
  }

  /**
   * Move a task to `failed`. Allowed from: `working`. Terminal.
   * @param {string} id
   * @param {Error|string} [error] Stored as a string on the task (`task.error`).
   * @returns {object} The updated task.
   */
  failTask(id, error) {
    const message = error instanceof Error ? error.message : error != null ? String(error) : 'unknown error';
    const task = this._transition(id, TASK_STATUS.FAILED, {
      patch: { error: message },
      note: `failed: ${message}`,
    });
    this._emit('task:failed', { task: this._clone(task) });
    return this._clone(task);
  }

  /**
   * Move a task to `cancelled`. Allowed from any non-terminal status (`pending`, `assigned`,
   * `working`) — cancellation is meant to work regardless of how far along a task is. Terminal.
   * @param {string} id
   * @param {string} [reason] Optional human-readable reason, stored on the task.
   * @returns {object} The updated task.
   */
  cancelTask(id, reason) {
    const task = this._transition(id, TASK_STATUS.CANCELLED, {
      patch: { error: reason || null },
      note: reason ? `cancelled: ${reason}` : 'cancelled',
    });
    this._emit('task:cancelled', { task: this._clone(task) });
    return this._clone(task);
  }

  // ---------------------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------------------

  /** @returns {object} The live (non-cloned) task object; throws if missing. */
  _requireTask(id) {
    const task = this._tasks.get(id);
    if (!task) {
      throw new TaskManagerError(`no task found with id "${id}"`, 'NOT_FOUND', { id });
    }
    return task;
  }

  _isTerminal(status) {
    return TERMINAL_STATUSES.has(status);
  }

  /**
   * Validate and apply a status transition, appending a history entry. Shared by every
   * `*Task` transition method above so the allowed-transition rules live in exactly one place.
   * @param {string} id
   * @param {string} nextStatus
   * @param {{ patch?: object, note?: string }} [opts]
   * @returns {object} The live (non-cloned) task, already updated.
   */
  _transition(id, nextStatus, opts) {
    opts = opts || {};
    const task = this._requireTask(id);
    const allowed = ALLOWED_TRANSITIONS[task.status] || [];
    if (!allowed.includes(nextStatus)) {
      throw new TaskManagerError(
        `cannot move task "${id}" from "${task.status}" to "${nextStatus}"`,
        'INVALID_TRANSITION',
        { id, from: task.status, to: nextStatus }
      );
    }
    if (opts.patch) Object.assign(task, opts.patch);
    task.status = nextStatus;
    task.updatedAt = this._now();
    task.history.push({ status: nextStatus, at: task.updatedAt, note: opts.note || nextStatus });
    return task;
  }

  /** Shallow-safe copy so callers can't mutate internal state through a returned task. */
  _clone(task) {
    return {
      ...task,
      metadata: { ...task.metadata },
      history: task.history.map((h) => ({ ...h })),
    };
  }

  _emit(event, payload) {
    if (!this._events) return;
    try {
      this._events.emit(event, payload);
    } catch (e) {
      // Never let a broken event bus / listener break task state changes.
    }
  }
}

module.exports = { TaskManager, TASK_STATUS, TaskManagerError };
