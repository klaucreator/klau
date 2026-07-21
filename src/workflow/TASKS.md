# TaskManager

`tasks/task-manager.js` tracks the lifecycle of a task: creation, edits, and status
transitions through to a terminal outcome, with a full history kept per task. It has no
dependency on Obsidian or any other module in the plugin, so any file under `src/` can
`require` it.

**Out of scope, deliberately:** deciding who or what works on a task, calling an AI
provider or a vault tool, or any UI rendering. TaskManager only answers "what's the current
state of this task, and how did it get there?" A future routing/agent layer would call into
it (`assignTask`, `startTask`, `completeTask`, ...) — none of that logic lives here.

## Import

```js
const { TaskManager, TASK_STATUS } = require('./tasks/task-manager');
```

## Basic usage

```js
const tasks = new TaskManager();

const task = tasks.createTask({ title: 'Summarize meeting notes' });
// task.status === TASK_STATUS.PENDING, task.id is a UUID

tasks.assignTask(task.id, 'agent-1');   // -> 'assigned'
tasks.startTask(task.id);                // -> 'working'
tasks.completeTask(task.id, { summary: 'Decided to ship next week.' }); // -> 'completed'

tasks.getTask(task.id);
// { id, title, status: 'completed', result: { summary: '...' }, ... }
```

## Statuses and transitions

```
pending ──assignTask──> assigned ──startTask──> working ──completeTask──> completed
   │                        │                       │
   │                        │                       └──failTask──> failed
   │                        │
   └────────────────────────┴───────cancelTask (from any non-terminal status)──> cancelled
```

`pending` and `assigned` can also go straight to `working` via `startTask` (assignment
isn't required to start work). `completed`, `failed`, and `cancelled` are terminal — no
further transitions or edits are allowed once a task reaches one of them.

Calling a transition method from a status that doesn't allow it throws a `TaskManagerError`
with `code: 'INVALID_TRANSITION'`.

## Updating task content

`updateTask` edits a task's title, description, assignee, or metadata — it never changes
`status`. Use the transition methods for that, so every status change is validated and
recorded in history the same way.

```js
tasks.updateTask(task.id, { description: 'Include action items.', metadata: { priority: 'high' } });
```

## Task history

Every task keeps its own timeline; `getHistory` returns it in order:

```js
tasks.getHistory(task.id);
// [
//   { status: 'pending',   at: 1737..., note: 'created' },
//   { status: 'assigned',  at: 1737..., note: 'assigned to agent-1' },
//   { status: 'working',   at: 1737..., note: 'work started' },
//   { status: 'completed', at: 1737..., note: 'completed' },
// ]
```

## Listing and filtering

```js
tasks.listTasks();                                  // every task
tasks.listTasks({ status: TASK_STATUS.WORKING });    // one status
tasks.listTasks({ status: [TASK_STATUS.PENDING, TASK_STATUS.ASSIGNED] }); // several
tasks.listTasks({ assigneeId: 'agent-1' });
```

## Errors

All TaskManager-raised errors are `TaskManagerError` (extends `Error`) with a `code`:

| code                | when                                                   |
|---------------------|---------------------------------------------------------|
| `INVALID_INPUT`     | missing/empty `title`, missing `assigneeId` for assign  |
| `NOT_FOUND`         | no task with the given id                                |
| `INVALID_TRANSITION`| the requested status change isn't allowed from the current status |
| `TASK_TERMINAL`     | `updateTask` called on a completed/failed/cancelled task |

```js
try {
  tasks.startTask('does-not-exist');
} catch (e) {
  if (e.code === 'NOT_FOUND') { /* ... */ }
}
```

## Optional: wiring up an EventBus

TaskManager works standalone, but if you pass an `EventBus` (see `core/event-bus.js`), it
publishes lifecycle events so other modules can react without TaskManager knowing who's
listening:

```js
const { EventBus } = require('../core/event-bus');
const { TaskManager } = require('./task-manager');

const tasks = new TaskManager({ eventBus: new EventBus() });
```

Events published (each payload is `{ task }`, a defensive copy of the task):

- `task:created`
- `task:updated`
- `task:assigned`
- `task:started`
- `task:completed`
- `task:failed`
- `task:cancelled`

## Notes on data returned

`createTask`, `getTask`, `listTasks`, `updateTask`, and every transition method return
**defensive copies** — mutating the returned object (or its `metadata`/`history`) never
affects TaskManager's internal state. Always go through the API to make changes.

Task ids are UUIDs (`crypto.randomUUID()` where available, with a fallback generator for
older mobile webviews that don't have it).
