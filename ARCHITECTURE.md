# Architecture

This plugin is organized by responsibility under `src/`. Obsidian loads
`main.js`, which does nothing but `module.exports = require('./src/core/plugin.js')`.

See `MIGRATION_NOTES.md` for what changed in this pass and why. The old
version of this file (pre-reorg) is kept as `ARCHITECTURE.md.old` for
reference.

```
src/
  core/          Plugin lifecycle, EventBus, settings persistence, shared constants
  providers/     AI provider HTTP requests + provider selection/routing
  agents/        BaseAgent, AgentRegistry, the tool-calling loop, and per-role agents
  tools/         What an agent (and Organize) can actually do to the vault
  workflow/      WorkflowEngine, TaskManager, and the Organize scan→prompt→plan pipeline
  memory/        Durable agent memory (MemoryManager)
  village/       The village state store + roster — the glue between agents/characters/buildings
  characters/    Visual NPC sprite roster (art only, no logic yet)
  buildings/     Reserved for per-building logic (Town Hall, Workshop, Court, …) — not yet populated
  assets/        Reserved for non-character art/audio — not yet populated
  integrations/  Reserved for Obsidian API adapters (Canvas, Templates, …) — not yet populated
  ui/            Views, modal, and settings tab — all Obsidian-facing rendering
```

### `core/`
- `constants.js` — view type IDs, `DEFAULT_SETTINGS`, the chat sidebar's no-tools system note.
- `plugin.js` — the `Plugin` subclass. Owns `onload`/`onunload`, view registration and
  ribbon/command wiring, settings load/save, and the sprite-URL resolver. Every
  feature-specific method delegates into the module that actually implements it.
- `event-bus.js`/`.d.ts` — the pub/sub bus every other module (tasks, agents, providers) can
  publish/subscribe on. See `EVENT_BUS.md` alongside it.

### `providers/`
- `sse.js` — the shared `"data: {...}"` stream reader used by both streaming providers.
- `anthropic.js` / `openai-compatible.js` — one file per provider type, pure functions:
  `(messages, provider, systemText[, onDelta])`.
- `index.js` — dispatches to the right provider by `provider.type`.
- `provider-manager.ts` — owns provider *selection*: which provider is active, failover,
  per-account keys.
- `9router-provider.ts` — a routing provider that picks among vendor providers rather than
  calling a model directly; it depends on `provider-manager.ts`, never the reverse.

### `agents/`
- `system-prompt.js` — the `AGENT_SYSTEM_PROMPT` text (tool list + rules) sent every turn.
- `agent-loop.js` — transcript compaction, retry-with-backoff, streaming-then-fallback, and
  parsing the model's JSON reply. Depends on `providers/`, not on Obsidian or the plugin.
- `base-agent.js`/`.d.ts` — the shared agent base class every role extends. See
  `BASE_AGENT.md` alongside it.
- `agent-registry.ts` — constructs and looks up agent instances by role.
- `roles/<role>/` — one folder per profession (`mayor/`, `planner/`, `architect/`,
  `programmer/`, `tester/`, `judge/`, `librarian/`, `warehouse-keeper/`, `painter/`,
  `scribe/`). Only `roles/mayor/mayor-agent.ts` is implemented so far — the rest are
  scaffolded empty, ready for the next agent to land without any structural change.

### `tools/`
- `tool-metadata.js` — `MUTATING_TOOLS` and `AGENT_EDITABLE_FIELDS`, read by the Agent view.
- `vault-mutations.js` — `ensureFolderExists` and `applyOrganizeAction`, the low-level
  "actually change a file" primitives, shared by Organize and the agent's vault tools.
- `web-search.js` — the DuckDuckGo-scrape implementation behind `search_web`.
- `vault-tools.js` — `runAgentTool(app, tool, args)`, the dispatch for every agent tool.
- `tool-manager.ts` — the registration point every agent goes through; no agent imports a
  tool file directly.

### `workflow/`
- `organize.js` — the Organize feature's scan → prompt → plan pipeline. Never calls
  `applyOrganizeAction` itself — planning and applying stay separate steps.
- `task-manager.js`/`.d.ts` — task creation, status, and event emission. See `TASKS.md`.
- `workflow-engine.ts` — orchestrates a task through the agent chain (Mayor → Planner →
  Architect → Programmer → Tester → Judge).

### `memory/`
- `memory-manager.js`/`.d.ts` — agent memory façade (short-/long-term to come). See
  `MEMORY.md`.

### `village/`
- `village-roster.js` — building coordinates (`VILLAGE_BUILDINGS`), the profession roster
  with sprite/emoji/idle-flavor info (`VILLAGE_PROFESSIONS`), and
  `resolveVillageProfession`.
- `village-store.js` — `VillageStore`, the in-memory pub/sub state store the chat/Organize/
  Agent features write to and the Village view reads from.
- `village-map.jpg` — the background art for the Village view.

This folder is intentionally the only place allowed to know about agents,
characters, *and* buildings at once — it's the composition layer, not a home
for new agent or tool logic.

### `characters/`
- `roster/<Role>/{north,south,east,west,north-east,north-west,south-east,south-west}.png` —
  the 8-directional sprite set per villager. Art only; no behavior code lives here yet
  (movement/animation/pathfinding are reserved for this folder once written).

### `ui/`
- `chat-view.js` — `AIChatView`, the sidebar chat panel.
- `organize-modal.js` — `OrganizeModal`, the preview/approve/apply dialog.
- `agent-view.js` — `AgentView`, the multi-step agent panel including team hand-offs.
- `village-view.js` — `VillageView`, the living-settlement renderer.
- `settings-tab.js` — `AIChatSettingTab`, all of Settings → AI Chat Sidebar.

### `buildings/`, `assets/`, `integrations/`
Reserved, currently empty. See `MIGRATION_NOTES.md` for what goes in each once
that work starts — nothing fabricated here to keep this an honest reflection
of what's actually implemented.
