# EventBus

`src/core/event-bus.js` is a standalone publish/subscribe event bus for the plugin. It has no
dependency on Obsidian or on any other module, so any file under `src/` can `require` it and use
it to communicate without importing each other directly.

This module is infrastructure only — nothing in the plugin currently constructs or emits on an
`EventBus` instance. Wiring specific features (agent steps, organize progress, village updates,
etc.) into it is a separate, deliberate follow-up; see "Adopting it in a module" below for how
that would look.

## Import

```js
const { EventBus } = require('./core/event-bus'); // path relative to the requiring file
```

## Basic publish/subscribe

```js
const bus = new EventBus();

const unsubscribe = bus.on('note:saved', (payload) => {
  console.log('saved', payload.path);
});

bus.emit('note:saved', { path: 'Inbox/todo.md' });
// -> "saved Inbox/todo.md"

unsubscribe(); // stop listening
```

## Multiple listeners

Every listener subscribed to an event runs, in the order it was added:

```js
bus.on('agent:step', (p) => renderStepInUi(p));
bus.on('agent:step', (p) => village.setStatus('mayor', 'working', { taskText: p.summary }));
bus.on('agent:step', (p) => console.log('step', p.stepNumber));

bus.emit('agent:step', { stepNumber: 3, summary: 'Reading note...' });
// all three listeners run
```

## Removing listeners

Two equivalent ways:

```js
// 1. Use the function returned by on()/once()
const off = bus.on('village:update', render);
off();

// 2. Keep the listener reference and call off() yourself
function render(payload) { /* ... */ }
bus.on('village:update', render);
bus.off('village:update', render);

// Remove everything for one event, or everything for every event (e.g. in a view's onClose())
bus.removeAllListeners('village:update');
bus.removeAllListeners();
```

## One-time listeners

```js
bus.once('agent:finished', (result) => {
  console.log('run complete:', result.summary);
});
// fires on the first "agent:finished" emit, then auto-unsubscribes
```

## Async listeners

`emit` works with sync and async listeners interchangeably, and returns a Promise that resolves
once every listener has settled — useful when a caller needs to know work triggered by the event
has actually finished:

```js
bus.on('organize:planReady', async (plan) => {
  await persistPlanToDisk(plan); // async listener — just works
});

bus.on('organize:planReady', (plan) => {
  showPlanInUi(plan); // sync listener — also just works
});

// Waits for both listeners (including the async one) to finish before continuing:
await bus.emit('organize:planReady', { actions: [] });

// Fire-and-forget is just as fine — emit() never rejects, so this is safe without awaiting:
bus.emit('organize:planReady', { actions: [] });
```

## Errors in one listener don't affect others

```js
bus.on('agent:step', () => { throw new Error('boom'); });
bus.on('agent:step', (p) => console.log('still runs', p));

await bus.emit('agent:step', { stepNumber: 1 });
// logs "[EventBus] listener error for "agent:step":" then "still runs { stepNumber: 1 }"
```

Custom error handling (e.g. to route into the plugin's own logging):

```js
const bus = new EventBus({
  onListenerError: (err, event) => console.error(`event bus (${event}) failed:`, err),
});
```

## TypeScript-friendly typing

The plugin ships as plain JS with no build step, but `event-bus.js` is fully JSDoc-annotated, so
editors and `// @ts-check` get real hints with zero setup. `event-bus.d.ts` sits alongside it for
projects/consumers that want to declare a typed event map explicitly:

```ts
import { EventBus } from './core/event-bus';

interface PluginEvents {
  'agent:step': { stepNumber: number; maxSteps: number };
  'agent:finished': { summary: string };
  'organize:planReady': { actions: unknown[] };
}

const bus = new EventBus<PluginEvents>();

bus.on('agent:step', (payload) => {
  // payload: { stepNumber: number; maxSteps: number }
});

bus.emit('agent:finished', { summary: 'done' }); // payload type-checked against PluginEvents
```

## Adopting it in a module (not done yet — shown for reference only)

A module that wants to publish events just needs a shared `EventBus` instance — e.g. one created
once in `core/plugin.js` and passed to (or read off) each module, the same way `VillageStore` is
today:

```js
// core/plugin.js (illustrative only — not part of this change)
const { EventBus } = require('./event-bus');
// ...
this.events = new EventBus();
```

```js
// some other module (illustrative only — not part of this change)
function doSomething(plugin) {
  plugin.events.emit('thing:done', { ok: true });
}
```

Nothing in this change modifies `plugin.js`, any UI file, or introduces agents — it only adds the
`EventBus` module itself plus this documentation.
