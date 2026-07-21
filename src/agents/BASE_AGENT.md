# BaseAgent

`src/agents/base-agent.js` defines the shape every agent (villager) in the AI Village will
share: an identity (`name`/`role`/`personality`) and a lifecycle through one task at a time
(`idle → waiting → thinking → working → idle`, or `→ error`). It has no dependency on
Obsidian, and optionally wires up to the other standalone modules the same "pass it in,
don't reach for a global" way they wire to each other.

**Out of scope, deliberately:** `_think` and `_act` — the actual reasoning and actual work —
are hooks a subclass overrides. BaseAgent defines *when* an agent thinks and acts, not
*what* it thinks or does. **No villager subclasses are defined in this file.**

## Import

```js
const { BaseAgent, AGENT_STATUS } = require('./src/agents/base-agent');
```

## Basic usage

```js
const agent = new BaseAgent({
  name: 'Scout',
  role: 'Explorer',
  personality: 'curious, terse',
});
agent.status; // 'idle'

await agent.receiveTask({ id: 't1', title: 'Survey the north road' });
agent.status; // 'waiting'

// BaseAgent has no behavior of its own — execute() will throw NOT_IMPLEMENTED here.
// A real villager subclass overrides _think / _act; see "Subclassing" below.
```

## Statuses and transitions

```
                 receiveTask()                execute()               completeTask()
      idle ─────────────────────> waiting ───────────────────> thinking ──> working ──> idle
       ▲                             │                             │           │
       │                             │                             │           │
       └─────────────── any status ──┴───────── (thrown error) ────┴───────────┘
                                                        │
                                                        v
                                                      error ──> idle (next receiveTask)
```

- `receiveTask(task)` — `idle`/`error` → `waiting`. Stores a copy of the task; does not
  start work.
- `execute(input?)` — runs `think()` then the subclass's `_act` hook then `completeTask()`.
  Requires a task already set via `receiveTask`.
- `think(input)` — `→ thinking`. Delegates to the overridable `_think` hook. Callable on its
  own, not just from `execute()`.
- `completeTask(result?)` — records the result, mirrors it onto `TaskManager` if wired up,
  and returns to `idle`.
- Any failure (a thrown error from `_think`, `_act`, or an invalid transition) moves the
  agent to `error` and records `lastError`. The next `receiveTask()` clears it.

## Subclassing

BaseAgent's default `_think` just echoes its input back, and its default `_act` throws
(`NOT_IMPLEMENTED`) — that's intentional, so calling `execute()` on a plain `BaseAgent`
fails loudly instead of silently "completing" a task nothing happened on. A real villager
overrides both:

```js
class Scout extends BaseAgent {
  async _think(input) {
    return { plan: `check the area described in: ${JSON.stringify(input)}` };
  }

  async _act(thought, task) {
    return { report: `${this.name} scouted and found nothing unusual.` };
  }
}

const scout = new Scout({ name: 'Scout', role: 'Explorer' });
await scout.receiveTask({ id: 't1', title: 'Survey the north road' });
const outcome = await scout.execute();
// outcome -> { agent: 'Scout', agentId: '...', task: {...}, result: { report: '...' } }
scout.status; // 'idle'
```

## Reporting

`report()` returns a UI-safe snapshot — no `eventBus`/`taskManager`/`memoryManager`
instances included — plus a one-line `summary` built from `name`/`role`/`status`:

```js
agent.report();
// {
//   id, name, role, personality, status,
//   currentTask, lastResult, lastError,
//   summary: 'Scout the Explorer is working on "Survey the north road".',
//   recentActivity: [ { status, note, at }, ... ]  // most recent maxLogEntries (default 20)
// }
```

## Errors

Every failure BaseAgent raises itself is a `BaseAgentError` with a `code`:

| code                | when                                                                 |
|---------------------|-----------------------------------------------------------------------|
| `INVALID_INPUT`     | missing/empty `name` at construction, or `receiveTask` called without a task object |
| `TASK_IN_PROGRESS`  | `receiveTask` called while the agent already has a current task       |
| `NO_TASK`           | `execute()` called with no task set (call `receiveTask` first)        |
| `NOT_IMPLEMENTED`   | `_act` was never overridden by a subclass                             |
| `INVALID_TRANSITION`| an internal status change isn't allowed from the current status       |

```js
try {
  await agent.execute();
} catch (e) {
  if (e.code === 'NO_TASK') { /* ... */ }
}
```

## Optional: wiring up TaskManager, MemoryManager, and EventBus

All three are optional constructor options. None are required for `BaseAgent` to work
standalone (handy for tests).

```js
const { EventBus } = require('../core/event-bus');
const { TaskManager } = require('../tasks/task-manager');
const { MemoryManager } = require('../memory/memory-manager');

const events = new EventBus();
const tasks = new TaskManager({ eventBus: events });
const memory = new MemoryManager({ eventBus: events });

const agent = new BaseAgent({
  name: 'Scout',
  role: 'Explorer',
  eventBus: events,
  taskManager: tasks,
  memoryManager: memory,
});
```

With `taskManager` wired up, the agent's lifecycle mirrors onto the matching `Task` —
`receiveTask` calls `assignTask`, moving to `working` (inside `execute()`) calls `startTask`,
`completeTask` calls `completeTask`, and a failure calls `failTask` — so a UI reading
`TaskManager` sees the same story a UI reading the agent sees. These mirrored calls are
best-effort: if
`TaskManager` rejects one (e.g. the task doesn't exist there, or is already terminal), the
agent's own state still moves forward.

With `memoryManager` wired up, every `think()` call records `{ agentId, input, thought }` as
short-term memory tagged `['agent:think', agentId]`.

With `eventBus` wired up, lifecycle steps publish:

- `agent:task-received`
- `agent:thought`
- `agent:acted`
- `agent:task-completed`
- `agent:status` (every status change, with `from`/`to`/`note`)
- `agent:error`

Each payload includes a small, stable `agent: { id, name, role }` identity object.

## Notes on data returned

`receiveTask`, `completeTask`, and `report()` all return **defensive copies** — mutating the
returned object never affects the agent's internal state. `currentTask` is likewise stored
as a shallow copy at `receiveTask` time, so mutating the caller's original task object
afterward doesn't affect the agent.

Agent ids are UUIDs (`crypto.randomUUID()` where available, with the same fallback generator
`tasks/task-manager.js` uses for older mobile webviews that don't have it).
