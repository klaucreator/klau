# MemoryManager

`memory/memory-manager.js` stores, searches, and forgets memory items across three tiers —
short-term, session, and long-term. It has no dependency on Obsidian, on any AI provider
(Anthropic, OpenAI, or otherwise), or on any specific persistence backend, so any file under
`src/` can `require` it, and it can be reused outside this plugin entirely.

**Out of scope, deliberately:** deciding *what* is worth remembering, summarizing/compressing
content, or calling an AI provider (e.g. for embeddings). MemoryManager stores whatever it's
given and answers "what do we remember, and how relevant is it?" — nothing more.

## Import

```js
const { MemoryManager, MEMORY_TIER } = require('./memory/memory-manager');
```

## The three tiers

| Tier         | Scope                              | How it goes away                                  |
|--------------|-------------------------------------|-----------------------------------------------------|
| `short-term` | A capped, most-recent-first buffer | Oldest item evicted once `shortTermLimit` is exceeded, or `clearShortTerm()` |
| `session`    | Scoped to a `sessionId`             | `clearSession(id)`, or `endSession(id)`             |
| `long-term`  | Durable, behind a swappable store   | `clearLongTerm()`, or `forget(id)`                  |

## Basic usage

```js
const memory = new MemoryManager({ shortTermLimit: 20 });

memory.rememberShortTerm('User just asked about pricing.');
memory.rememberSession('chat-42', 'User is planning a trip to Kyoto in October.', { tags: ['trip'] });
memory.rememberLongTerm("User's name is Priya.", { tags: ['profile'], importance: 0.9 });

memory.recall(someId);                  // -> item, or null if missing/expired
memory.list({ tier: 'session', sessionId: 'chat-42' });
memory.search('Kyoto');                 // -> ranked matches across all tiers
memory.forget(someId);                  // -> true/false
```

## Search

`search(query, opts)` ranks items by word-overlap against their (stringified) content and
tags, with a small recency/importance tie-break — no embeddings, no AI provider call. If you
need semantic search over long-term memory specifically, back `longTermStore` with something
smarter (e.g. a vector DB) and layer your own search on top; MemoryManager's own `search` still
works for everything else.

```js
memory.search('peanuts allergy', { tier: 'long-term', limit: 5 });
```

## Promotion and ending a session

Session memory is meant to be short-lived — one conversation's worth of context. When it's
over, either just drop it, or carry the important bits into long-term memory first:

```js
// Just drop everything for this session:
memory.clearSession('chat-42');

// Or: promote only high-importance items, then clear:
memory.endSession('chat-42', { promote: (item) => item.importance >= 0.7 });

// Or: promote a single item explicitly, any time:
memory.promote(itemId);
```

## Long-term memory interface

`long-term` storage sits behind a small interface — `add`, `get`, `list`, `update`, `delete`,
`clear`, `toJSON`, `fromJSON` — so MemoryManager never assumes *how* long-term memory is kept.
The default, `InMemoryLongTermStore`, just keeps a `Map` (gone when the process exits — pair
it with `exportJSON`/`importJSON` below for real persistence). Swap in anything else —
a JSON file on disk, an Obsidian vault file, a database, a vector store — by implementing the
same eight methods:

```js
class MyFileBackedStore {
  add(item) { /* ... */ return item; }
  get(id) { /* ... */ }
  list() { /* ... */ }
  update(id, patch) { /* ... */ }
  delete(id) { /* ... */ }
  clear() { /* ... */ }
  toJSON() { /* return item[] */ }
  fromJSON(items) { /* replace internal state */ }
}

const memory = new MemoryManager({ longTermStore: new MyFileBackedStore() });
```

MemoryManager validates the store at construction time and throws a `MemoryManagerError`
(`code: 'INVALID_STORE'`) if any method is missing.

## Save / load as JSON

`toJSON()`/`loadJSON()` work with plain objects; `exportJSON()`/`importJSON()` work with JSON
strings. Both cover all three tiers (short-term, every session, and whatever the long-term
store itself serializes).

```js
const json = memory.exportJSON();       // string — e.g. write to a file or Obsidian's saveData
// ...later, possibly in a new process...
const restored = MemoryManager.fromJSON(JSON.parse(json));
// or, into an existing instance:
memory.importJSON(json);
```

## Errors

Every failure MemoryManager raises itself is a `MemoryManagerError` with a `code`:

- `INVALID_INPUT` — missing/empty `content`, unknown `tier`, missing `sessionId` for
  session-tier memory, or invalid JSON passed to `importJSON`.
- `NOT_FOUND` — `promote(id)` called with an id that isn't in short-term or session memory.
- `INVALID_STORE` — a `longTermStore` option missing one or more required methods.

## Events (optional)

Pass an `EventBus` (see `core/event-bus.js`) to get notified of state changes without
MemoryManager knowing who's listening:

```js
const { EventBus } = require('../core/event-bus');
const memory = new MemoryManager({ eventBus: new EventBus() });
```

Events emitted: `memory:remembered`, `memory:evicted` (short-term/session capacity overflow),
`memory:forgotten`, `memory:promoted`, `memory:sessionEnded`, `memory:cleared`, `memory:loaded`.
