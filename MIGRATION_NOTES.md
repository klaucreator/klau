# Migration notes — flat zip → target architecture

This pass took the flat file dump from the zip (everything at the plugin
root, plus four zipped-up modules: `event-bus`, `task-manager`,
`memory-manager`, `base-agent`) and arranged it into the structure from
`ARCHITECTURE_PROPOSAL.md`, wiring imports so it's require()-consistent.

## What moved where

| From (flat zip) | To |
|---|---|
| `constants.js`, `plugin.js` | `src/core/` |
| `event-bus-src-core.zip` contents | `src/core/` |
| `index.js`, `anthropic.js`, `openai-compatible.js`, `sse.js` | `src/providers/` |
| `provider-manager.ts`, `9router-provider.ts` | `src/providers/` |
| `agent-loop.js`, `system-prompt.js` | `src/agents/` |
| `base-agent.zip` contents | `src/agents/` |
| `agent-registry.ts` | `src/agents/` |
| `mayor-agent.ts` | `src/agents/roles/mayor/` |
| `organize.js`, `workflow-engine.ts` | `src/workflow/` |
| `task-manager.zip` contents | `src/workflow/` |
| `tool-metadata.js`, `vault-tools.js`, `vault-mutations.js`, `web-search.js`, `tool-manager.ts` | `src/tools/` |
| `memory-manager.zip` contents | `src/memory/` |
| `village-store.js`, `village-roster.js`, `village-map.jpg` | `src/village/` (not `memory/` — see architecture doc, §6/§10 reasoning) |
| `characters/<Role>/*.png` | `src/characters/roster/<Role>/` |
| `chat-view.js`, `agent-view.js`, `village-view.js`, `organize-modal.js`, `settings-tab.js` | `src/ui/` |

`buildings/`, `assets/`, `integrations/` were created empty — nothing real
exists for them yet, so no files were invented to fill them.

## Import paths that had to change

The zipped modules were authored assuming slightly different sibling
folders than the final layout, and two files still pointed at the old
`memory/village-*` location. Fixed:

- `src/ui/agent-view.js` — `../memory/village-roster` → `../village/village-roster`
- `src/ui/village-view.js` — `../memory/village-roster` → `../village/village-roster`
- `src/core/plugin.js` — `../memory/village-store` → `../village/village-store`
- `src/agents/roles/mayor/mayor-agent.ts`:
  - `../core/event-bus` → `../../../core/event-bus` (now 3 levels deep under `roles/mayor/`)
  - `../tasks/task-manager` → `../../../workflow/task-manager` (task-manager lives in `workflow/`, not a top-level `tasks/`)
  - `./base-agent` → `../../base-agent` (base-agent stays directly in `agents/`, not per-role)
- `src/providers/9router-provider.ts` — `../core/provider-manager` → `./provider-manager`
  (provider-manager lives alongside it in `providers/`, not in `core/`)
- `src/workflow/workflow-engine.ts` — `../tasks/task-manager` → `./task-manager` (same folder now)

Everything else (`provider-manager.ts`'s own `../core/event-bus` import,
`workflow-engine.ts`'s `../core/event-bus` import, all the plain `.js`
requires) already resolved correctly once the folders landed in the
proposed spots, since `providers/`, `agents/`, `workflow/`, `tools/`, `ui/`,
`memory/`, and `village/` are all siblings one level under `src/`.

All `.js` files were run through `node --check` after the move — no syntax
errors. This does **not** guarantee the app boots (the `.ts` files aren't
yet wired into `plugin.js` at all — `agent-registry.ts`, `provider-manager.ts`,
`9router-provider.ts`, `workflow-engine.ts`, `task-manager`, `base-agent`,
and `mayor-agent.ts` are the "existing foundation" pieces the original brief
described as not-yet-integrated; only the previously-working `.js` plugin
still runs as-is). Wiring those into `plugin.js`/`core` bootstrap is the
next real step, not something this reorg pass should silently do for you.

## Next real steps (not done here, on purpose)
1. Wire `AgentRegistry`/`ProviderManager`/`WorkflowEngine`/`TaskManager` into
   `core/plugin.js`'s `onload`, per the startup order in
   `ARCHITECTURE_PROPOSAL.md` §4.
2. Split `providers/anthropic.js` / `openai-compatible.js` into the full
   vendor set (`gemini-provider.ts`, `ollama-provider.ts`, etc.) once those
   integrations exist.
3. Populate `agents/roles/{planner,architect,programmer,tester,judge,
   librarian,warehouse-keeper,painter,scribe}/` one at a time.
4. Start `buildings/` and `village/village-simulation-loop.ts` once you want
   agent activity to visibly move characters between buildings.
