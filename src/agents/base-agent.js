'use strict';

/**
 * BaseAgent — the common shape every agent (villager) in the AI Village will share.
 *
 * Owns exactly one thing: a single agent's identity (`name`/`role`/`personality`) and its
 * lifecycle through one task (`idle → waiting → thinking → working → idle`, or `→ error`).
 * It has no dependency on Obsidian and no dependency on any specific villager — this file
 * defines the shape, not a character. It optionally wires up to the other standalone
 * modules the same "pass it in, don't reach for a global" way they wire to each other:
 *
 * - `taskManager` (see `tasks/task-manager.js`) — if provided, `receiveTask`/`completeTask`
 *   mirror the agent's lifecycle onto the matching `Task` (`assignTask`/`completeTask`/
 *   `failTask`), so a UI reading `TaskManager` sees the same story a UI reading the agent
 *   would see.
 * - `memoryManager` (see `src/memory/memory-manager.js`) — if provided, `think()` records
 *   its input/output as short-term memory tagged with the agent's id, so later turns (or a
 *   future "what have I been doing" view) can recall it.
 * - `eventBus` (see `src/core/event-bus.js`) — if provided, every lifecycle step publishes
 *   an `agent:*` event, so UI (a village view, a chat panel, ...) can react without the
 *   agent knowing who's listening.
 *
 * All three are optional — `new BaseAgent({ name: 'Scout' })` works standalone and is handy
 * for tests.
 *
 * **Deliberately out of scope (by design, not omission):** BaseAgent does not decide *what*
 * a task means or *how* to do it — `_think` and `_act` are no-op/throwing hooks a subclass
 * (a specific villager) overrides with real reasoning and real work. No villager subclasses
 * are defined in this file.
 *
 * @example
 * const { BaseAgent, AGENT_STATUS } = require('./src/agents/base-agent');
 *
 * const agent = new BaseAgent({ name: 'Scout', role: 'Explorer', personality: 'curious, terse' });
 * agent.status; // 'idle'
 *
 * await agent.receiveTask({ id: 't1', title: 'Survey the north road' });
 * agent.status; // 'waiting'
 *
 * const outcome = await agent.execute();
 * agent.status; // 'idle' again (or 'error' if _act threw)
 * agent.report(); // { id, name, role, personality, status, currentTask, lastResult, ... }
 */

/** @type {Readonly<Record<string, string>>} */
const AGENT_STATUS = Object.freeze({
  IDLE: 'idle',
  THINKING: 'thinking',
  WORKING: 'working',
  WAITING: 'waiting',
  ERROR: 'error',
});

/**
 * Which status an agent may move to next, keyed by its current status. Mirrors the
 * "validated transition" shape `tasks/task-manager.js` uses (`ALLOWED_TRANSITIONS` +
 * `_transition`), so an agent can't silently end up in a nonsensical state (e.g. jumping
 * straight from `idle` to `working` with no task).
 */
const ALLOWED_TRANSITIONS = Object.freeze({
  [AGENT_STATUS.IDLE]: [AGENT_STATUS.WAITING, AGENT_STATUS.THINKING, AGENT_STATUS.ERROR],
  [AGENT_STATUS.WAITING]: [AGENT_STATUS.THINKING, AGENT_STATUS.WORKING, AGENT_STATUS.IDLE, AGENT_STATUS.ERROR],
  [AGENT_STATUS.THINKING]: [AGENT_STATUS.WORKING, AGENT_STATUS.WAITING, AGENT_STATUS.IDLE, AGENT_STATUS.ERROR],
  [AGENT_STATUS.WORKING]: [AGENT_STATUS.IDLE, AGENT_STATUS.WAITING, AGENT_STATUS.THINKING, AGENT_STATUS.ERROR],
  [AGENT_STATUS.ERROR]: [AGENT_STATUS.IDLE],
});

/**
 * Error type for every failure BaseAgent raises itself (missing name, no task to execute,
 * an unimplemented hook, an invalid status transition). Lets callers
 * `catch (e) { if (e.code === 'NO_TASK') ... }` instead of string-matching messages — same
 * convention as `TaskManagerError` / `MemoryManagerError`.
 */
class BaseAgentError extends Error {
  constructor(message, code, details) {
    super(message);
    this.name = 'BaseAgentError';
    this.code = code || 'BASE_AGENT_ERROR';
    if (details) this.details = details;
  }
}

/**
 * RFC 4122 v4 UUID, same generator (and same fallback for older mobile webviews without
 * `crypto.randomUUID`) as `tasks/task-manager.js`, kept local so this file has no import-time
 * dependency on that module.
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

class BaseAgent {
  /**
   * @param {object} options
   * @param {string} options.name Required, non-empty. The agent's display name.
   * @param {string} [options.role] What the agent is for (e.g. "Explorer", "Archivist").
   * @param {string} [options.personality] Free-text flavor used by `report()` and left for
   *   subclasses/prompts to draw on (tone, quirks, speech patterns — whatever a future
   *   villager wants).
   * @param {string} [options.id] Stable id. Defaults to a generated UUID.
   * @param {import('../core/event-bus').EventBus} [options.eventBus] Optional; lifecycle
   *   steps are published on it (`agent:*`) if provided.
   * @param {import('../tasks/task-manager').TaskManager} [options.taskManager] Optional;
   *   `receiveTask`/`completeTask`/failures mirror onto the matching `Task` if provided.
   * @param {import('../memory/memory-manager').MemoryManager} [options.memoryManager]
   *   Optional; `think()` records its input/output as short-term memory if provided.
   * @param {number} [options.maxLogEntries] How many recent activity entries `report()`
   *   includes. Defaults to 20.
   * @param {() => number} [options.now] Clock override, mainly for tests.
   * @param {() => string} [options.idFactory] Id generator override, mainly for tests.
   */
  constructor(options) {
    options = options || {};
    if (typeof options.name !== 'string' || !options.name.trim()) {
      throw new BaseAgentError('name is required to create an agent', 'INVALID_INPUT');
    }

    this._now = typeof options.now === 'function' ? options.now : () => Date.now();
    const generate = typeof options.idFactory === 'function' ? options.idFactory : generateId;

    this.id = options.id || generate();
    this.name = options.name.trim();
    this.role = typeof options.role === 'string' ? options.role : '';
    this.personality = typeof options.personality === 'string' ? options.personality : '';

    /** @type {string} Current lifecycle status — one of AGENT_STATUS. */
    this.status = AGENT_STATUS.IDLE;
    /** @type {object|null} The task currently assigned to this agent, or null. */
    this.currentTask = null;
    /** @type {*} Whatever `completeTask` was last given as a result. */
    this.lastResult = null;
    /** @type {string|null} The message from the most recent failure, if any. */
    this.lastError = null;

    this._events = options.eventBus || null;
    this._tasks = options.taskManager || null;
    this._memory = options.memoryManager || null;
    this._maxLogEntries = Number.isFinite(options.maxLogEntries) ? options.maxLogEntries : 20;
    /** @type {{status: string, note: string, at: number}[]} Recent status-transition log. */
    this._log = [];

    this._pushLog(this.status, 'created');
  }

  // ---------------------------------------------------------------------------------------
  // Task lifecycle
  // ---------------------------------------------------------------------------------------

  /**
   * Accept a task and move the agent from `idle` (or `error`, once acknowledged) to
   * `waiting`. Does not start work — call `execute()` for that. Accepts either a `Task`
   * object from `TaskManager` (with an `id`) or any plain `{ title, description, ... }`
   * object; either way a shallow copy is stored on `currentTask`, so mutating the caller's
   * object afterward doesn't affect the agent.
   *
   * @param {object} task
   * @param {string} [task.id]
   * @param {string} [task.title]
   * @returns {object} The stored copy of the task.
   */
  async receiveTask(task) {
    if (!task || typeof task !== 'object') {
      throw new BaseAgentError('receiveTask requires a task object', 'INVALID_INPUT');
    }
    if (this.currentTask) {
      throw new BaseAgentError(
        `agent "${this.name}" is already handling a task — call completeTask() first`,
        'TASK_IN_PROGRESS',
        { agentId: this.id, currentTaskId: this.currentTask.id }
      );
    }
    this.currentTask = { ...task };
    this.lastError = null;
    this._setStatus(AGENT_STATUS.WAITING, `received task "${task.title || task.id || 'untitled'}"`);

    if (this._tasks && task.id) {
      try {
        this._tasks.assignTask(task.id, this.id);
      } catch (e) {
        // Non-fatal: the agent still tracks the task locally even if TaskManager rejects
        // the mirrored transition (e.g. it's already assigned elsewhere).
      }
    }
    this._emit('agent:task-received', { agent: this._identity(), task: { ...this.currentTask } });
    return { ...this.currentTask };
  }

  /**
   * Run the current task end to end: `think()` about it, then hand the result to the
   * subclass's `_act` hook to actually do the work, then `completeTask()`. Requires a task
   * to already be set via `receiveTask()`.
   *
   * BaseAgent itself has no work to do — `_act` throws `NOT_IMPLEMENTED` unless a subclass
   * overrides it. That's intentional: this class defines the lifecycle, not a specific
   * villager's behavior.
   *
   * @param {*} [input] What to think about. Defaults to the current task.
   * @returns {Promise<object>} The same shape `completeTask()` returns.
   */
  async execute(input) {
    if (!this.currentTask) {
      throw new BaseAgentError(
        `agent "${this.name}" has no task to execute — call receiveTask() first`,
        'NO_TASK',
        { agentId: this.id }
      );
    }
    try {
      const thought = await this.think(input !== undefined ? input : this.currentTask);

      this._setStatus(AGENT_STATUS.WORKING, 'acting on task');
      if (this._tasks && this.currentTask && this.currentTask.id) {
        try {
          this._tasks.startTask(this.currentTask.id);
        } catch (e) {
          // Non-fatal — see receiveTask's note on mirrored TaskManager calls.
        }
      }
      const result = await this._act(thought, { ...this.currentTask });
      this._emit('agent:acted', { agent: this._identity(), task: { ...this.currentTask }, result });

      return this.completeTask(result);
    } catch (err) {
      this._fail(err);
      throw err;
    }
  }

  /**
   * Reasoning step, run before `_act`. Moves the agent to `thinking`, delegates to the
   * overridable `_think` hook, and — if a `memoryManager` was provided — records the
   * input/output pair as short-term memory tagged with this agent's id and role.
   *
   * Safe to call on its own (not just from `execute()`) if a caller wants an agent's
   * opinion on something without committing it to act.
   *
   * @param {*} input
   * @returns {Promise<*>} Whatever `_think` returns. BaseAgent's default `_think` returns a
   *   placeholder — subclasses should override it with real reasoning.
   */
  async think(input) {
    this._setStatus(AGENT_STATUS.THINKING, 'thinking');
    try {
      const thought = await this._think(input);
      if (this._memory) {
        try {
          this._memory.rememberShortTerm(
            { agentId: this.id, input, thought },
            { tags: ['agent:think', this.id] }
          );
        } catch (e) {
          // Non-fatal: memory is a nice-to-have, not required for thinking to succeed.
        }
      }
      this._emit('agent:thought', { agent: this._identity(), input, thought });
      return thought;
    } catch (err) {
      this._fail(err);
      throw err;
    }
  }

  /**
   * Mark the current task done, record the result, mirror it onto `TaskManager` if wired
   * up, and return the agent to `idle`. Can be called directly (e.g. by a caller that ran
   * work outside of `execute()`) as well as internally by `execute()`.
   *
   * @param {*} [result] Arbitrary result payload.
   * @returns {{agent: string, agentId: string, task: object|null, result: *}}
   */
  completeTask(result) {
    const task = this.currentTask;
    this.lastResult = result !== undefined ? result : null;

    if (this._tasks && task && task.id) {
      try {
        this._tasks.completeTask(task.id, this.lastResult);
      } catch (e) {
        // Non-fatal — see receiveTask's note on mirrored TaskManager calls.
      }
    }

    this._setStatus(AGENT_STATUS.IDLE, 'task completed');
    const outcome = { agent: this.name, agentId: this.id, task: task ? { ...task } : null, result: this.lastResult };
    this._emit('agent:task-completed', { agent: this._identity(), ...outcome });
    this.currentTask = null;
    return outcome;
  }

  // ---------------------------------------------------------------------------------------
  // Reporting
  // ---------------------------------------------------------------------------------------

  /**
   * Snapshot of the agent's current identity and state — safe to hand to a UI or log
   * without exposing internal wiring (`eventBus`/`taskManager`/`memoryManager` instances
   * are never included). Includes a one-line human-readable `summary` built from
   * `name`/`role`/`status`, since `personality` is otherwise just inert flavor text.
   *
   * @returns {object}
   */
  report() {
    return {
      id: this.id,
      name: this.name,
      role: this.role,
      personality: this.personality,
      status: this.status,
      currentTask: this.currentTask ? { ...this.currentTask } : null,
      lastResult: this.lastResult,
      lastError: this.lastError,
      summary: this._summarize(),
      recentActivity: this._log.slice(-this._maxLogEntries).map((entry) => ({ ...entry })),
    };
  }

  // ---------------------------------------------------------------------------------------
  // Overridable hooks — BaseAgent defines the lifecycle, subclasses define the behavior
  // ---------------------------------------------------------------------------------------

  /**
   * Override in a subclass to do real reasoning. BaseAgent's default just echoes the input
   * back with a note, so `execute()` still completes end-to-end for a plain `BaseAgent`
   * (useful for tests and wiring checks) without pretending to be intelligent.
   * @param {*} input
   * @returns {Promise<*>|*}
   */
  async _think(input) {
    return { note: `${this.name} has no reasoning implemented — override _think in a subclass.`, input };
  }

  /**
   * Override in a subclass to do real work. BaseAgent has none — this throws so that
   * calling `execute()` on a plain `BaseAgent` fails loudly (`NOT_IMPLEMENTED`) instead of
   * silently "completing" a task nothing actually happened on.
   * @param {*} thought Whatever `think()` produced.
   * @param {object} task A copy of the current task.
   * @returns {Promise<*>|*}
   */
  async _act(thought, task) {
    throw new BaseAgentError(
      `agent "${this.name}" has no behavior implemented — override _act in a subclass`,
      'NOT_IMPLEMENTED',
      { agentId: this.id, taskId: task ? task.id : null }
    );
  }

  // ---------------------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------------------

  /**
   * Validate and apply a status transition, appending to the activity log and publishing
   * `agent:status` if an eventBus is wired up. Every public method that changes `status`
   * goes through this, mirroring `TaskManager._transition`'s single-source-of-truth shape.
   * @param {string} next
   * @param {string} [note]
   */
  _setStatus(next, note) {
    const allowed = ALLOWED_TRANSITIONS[this.status] || [];
    if (this.status !== next && !allowed.includes(next)) {
      throw new BaseAgentError(
        `agent "${this.name}" cannot move from "${this.status}" to "${next}"`,
        'INVALID_TRANSITION',
        { agentId: this.id, from: this.status, to: next }
      );
    }
    const from = this.status;
    this.status = next;
    this._pushLog(next, note || next);
    if (from !== next) {
      this._emit('agent:status', { agent: this._identity(), from, to: next, note: note || null });
    }
  }

  /** Move to `error`, record the message, and mirror onto TaskManager if wired up. */
  _fail(err) {
    this.lastError = err instanceof Error ? err.message : err != null ? String(err) : 'unknown error';
    if (this._tasks && this.currentTask && this.currentTask.id) {
      try {
        this._tasks.failTask(this.currentTask.id, err);
      } catch (e) {
        // Non-fatal — see receiveTask's note on mirrored TaskManager calls.
      }
    }
    // error is reachable from every status, so this never fails validation itself.
    this.status = AGENT_STATUS.ERROR;
    this._pushLog(AGENT_STATUS.ERROR, this.lastError);
    this._emit('agent:error', { agent: this._identity(), error: this.lastError, task: this.currentTask ? { ...this.currentTask } : null });
  }

  _pushLog(status, note) {
    this._log.push({ status, note, at: this._now() });
    if (this._log.length > this._maxLogEntries) {
      this._log.splice(0, this._log.length - this._maxLogEntries);
    }
  }

  /** One-line flavor summary for `report()`. */
  _summarize() {
    const rolePart = this.role ? ` the ${this.role}` : '';
    switch (this.status) {
      case AGENT_STATUS.IDLE:
        return `${this.name}${rolePart} is idle.`;
      case AGENT_STATUS.WAITING:
        return `${this.name}${rolePart} is waiting to start "${this.currentTask ? this.currentTask.title || this.currentTask.id : 'a task'}".`;
      case AGENT_STATUS.THINKING:
        return `${this.name}${rolePart} is thinking.`;
      case AGENT_STATUS.WORKING:
        return `${this.name}${rolePart} is working on "${this.currentTask ? this.currentTask.title || this.currentTask.id : 'a task'}".`;
      case AGENT_STATUS.ERROR:
        return `${this.name}${rolePart} hit an error: ${this.lastError || 'unknown error'}.`;
      default:
        return `${this.name}${rolePart} is ${this.status}.`;
    }
  }

  /** Small, stable identity payload attached to every emitted event. */
  _identity() {
    return { id: this.id, name: this.name, role: this.role };
  }

  _emit(event, payload) {
    if (!this._events) return;
    try {
      this._events.emit(event, payload);
    } catch (e) {
      // Never let a broken event bus / listener break agent state changes.
    }
  }
}

module.exports = { BaseAgent, BaseAgentError, AGENT_STATUS };
