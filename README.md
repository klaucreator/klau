# AI Chat Sidebar (Obsidian plugin)

Chat with Claude — or any OpenAI-compatible API (OpenAI, local models via
Ollama/LM Studio, OpenRouter, etc.) — from a sidebar panel in Obsidian.

No build step needed: the plugin is plain JavaScript, so you can install it
by copying three files into your vault.

## Install

1. In your vault, go to `.obsidian/plugins/` and create a folder called
   `ai-chat-sidebar`.
2. Copy `manifest.json`, `main.js`, `styles.css`, `village-map.jpg`, and the
   `characters/` folder into that folder — the village view needs the
   background art plus the character sprites for each villager.
3. In Obsidian: **Settings → Community plugins**. Turn off "Restricted mode"
   if it's on, then find **AI Chat Sidebar** in the installed list and
   enable it.
4. Open **Settings → AI Chat Sidebar** and paste in your API key(s):
   - **Claude**: paste your Anthropic API key (from console.anthropic.com).
     Base URL defaults to `https://api.anthropic.com`.
   - **Custom (OpenAI-compatible)**: paste your key and set the Base URL to
     whichever OpenAI-compatible endpoint you want — OpenAI itself, a local
     server (e.g. `http://localhost:11434/v1` for Ollama), OpenRouter, etc.
5. Click the chat-bubble icon in the left ribbon (or run the command
   "Open AI chat sidebar") to open the panel on the right.

## Using it

- Pick the active provider from the dropdown at the top of the panel.
- Check "Include current note" to send the open note's content as context
  along with your message.
- Enter sends the message; Shift+Enter adds a newline.
- "Clear" resets the conversation (settings and API keys are untouched).

## Adding more providers

In settings, click **Add provider** to configure additional accounts —
for example a second Claude key, or several different OpenAI-compatible
endpoints. Each provider stores its own key, base URL, and model name, so
you can switch between them from the dropdown without re-entering anything.

## About authentication

Right now the plugin uses API keys, entered directly in settings and stored
in your vault's plugin data (not synced anywhere by the plugin itself).
OAuth-style "log in with your account" support is a natural next step —
the provider list in `main.js` is written so a new `type` (e.g. `'oauth'`)
and its own request handler can be added later without touching the chat UI
or settings UI.

## Organize your vault with AI (preview & confirm)

Run the command **"Organize vault with AI (preview & confirm)"** (via the
command palette, `Ctrl/Cmd+P`) or click **"Open organize preview"** in
settings.

What it does:
1. Scans your markdown files (path, tags, a short content preview — capped
   at "Max files to scan" in settings, default 150).
2. Sends that summary to your active AI provider and asks for a plan:
   moves, renames, and/or tag additions.
3. Shows every proposed change in a checklist, each with the AI's reason.
   **Nothing is applied yet at this point.**
4. You uncheck anything you don't want, then click **Apply selected**.
   Only the changes you approved happen — one at a time, with errors
   reported per-item rather than failing silently.

Hard safety rules built into this feature:
- It can only **move, rename, or add tags** — it can never delete a file.
- It only acts on files it was actually shown; if the AI's response
  mentions a path that wasn't in the scanned list, that action is dropped
  automatically before you even see the preview.
- Renames/moves go through Obsidian's `fileManager.renameFile`, which
  updates links pointing to the note elsewhere in your vault.
- If you close the preview without clicking Apply, nothing happens.

This is separate from the chat sidebar — chatting with the AI (asking it
to "organize my notes" in the chat panel) only produces a text reply and
can't touch your files. Use this command specifically to get an actual,
reviewable plan.

## AI Agent (multi-step, tool-using)

Open it via the robot icon in the ribbon, the command **"Open AI agent"**,
or the button in settings. This is different from both the chat sidebar
and the Organize command:

- **Chat sidebar**: one message in, one reply out. Never touches files.
- **Organize command**: one AI pass over your whole vault, one batch of
  proposed changes, one approval step.
- **Agent**: you give it a goal ("find all notes mentioning X and tag them",
  "draft a summary note pulling from these three files"), and it works
  through it step by step on its own — reading, searching, and deciding
  what to do next based on what it finds — for up to "Max steps per run"
  iterations (default 20).

Available tools: `list_files`, `read_note`, `read_notes` (batch, up to 10
paths at once), `get_note_metadata` (tags/frontmatter/word count/dates
without dumping content), `search_notes`, `search_web` (all read-only, run
automatically), and `write_note`, `append_note`, `add_tags`, `move_note`,
`rename_note`, `create_folder`, `delete_note` (these change your vault).

`search_web` looks up current information on the open web (via a free
DuckDuckGo search — no API key or setup needed).

**By default, every file-changing tool call pauses and shows an
Approve/Skip prompt in the log before anything happens** — the agent keeps
reasoning and reading on its own, but never mutates a file without your
explicit click. For tools with an obvious "main" field (the new content for
`write_note`/`append_note`, the tags for `add_tags`, the destination for
`move_note`/`rename_note`/`create_folder`), that field is editable right in
the approval prompt, so you can tweak what the agent is about to do before
confirming it. If you skip a step, the agent is told it was skipped and
carries on from there. There's an "Auto-approve file changes" toggle in
settings if you want it to run fully unattended — off by default, and
worth turning on only once you trust it and have backups (e.g. Git, Obsidian
Sync version history, or a synced backup folder).

`delete_note` moves a note to the trash (system trash, falling back to
Obsidian's own `.trash` folder) — it's recoverable, never a permanent
delete, and it's approval-gated like every other mutating tool. Any tool
call referencing a file that wasn't actually returned by `list_files` /
`read_note` / `read_notes` / `search_notes` / `get_note_metadata` will
simply fail with an error rather than silently doing something to an
unverified path.

A few reliability notes for long or flaky runs:
- Responses stream in live where the environment supports it, so you can
  watch the agent's raw reply arrive instead of staring at a blank log —
  it falls back to a normal (non-streaming) request automatically if
  streaming isn't available.
- A transient failure (rate limit, momentary network error, provider
  overload) is retried automatically with backoff before it's reported as
  an error.
- On long runs, older tool-call/result pairs are collapsed into a short
  summary before being sent to the model, so the request doesn't keep
  growing without bound over many steps — this matters most for local
  models with small context windows.
- The panel shows a live "Step X / Y" counter while running, and a "Copy
  log" button to grab the full run transcript as text.

## Agent teams ("village" mode)

By default the Agent runs as a single generalist. If you want specialized
roles working together on one goal, define them in **Settings → Agent team
(optional)**: give each a name (e.g. "Researcher", "Organizer", "Writer")
and role instructions (what it should focus on / how it should behave).

Once you've defined at least one role, the Agent panel shows a checklist
above the goal box. Check the roles you want, in the order you want them
to run, then hit Run:

- Before anyone starts working, the whole checked team first gathers at
  the **Town Hall** in the Village view for a quick briefing (a couple of
  seconds, purely visual) — then each member walks off to their own
  building as their stage begins, in order.
- Each checked member runs its own full tool-using loop (same read/search/
  write/tag/move/rename tools, same approval gates) with its own role
  instructions layered on top of the base agent behavior.
- When one member finishes, its final message is handed to the next member
  as context, along with the original overall goal — so a "Researcher" can
  gather info and a "Writer" can then turn it into a note, for example.
- Leave everything unchecked and it behaves exactly like the single-agent
  mode described above — nothing changes if you don't set up a team.

The approval-before-mutation rule applies per team member too: every
write/tag/move/rename step from any member still pauses for your Approve/
Skip, unless you've turned on auto-approve in settings.

## AI Village

Open it via the castle icon in the ribbon, the command **"Open AI village"**,
or the button in settings. This is a living, in-character view of everything
the other three features are doing — it never calls an AI provider itself,
it just visualizes what's already happening.

Every AI "villager" maps to something you're actually running:
- The **chat sidebar** shows up as the **Innkeeper**, at the Market —
  "displays conversations, stores chat history, welcomes users" fits a tavern.
- The **Organize** command shows up as the **Librarian**, at the Library.
- A **solo Agent** run shows up as the **Mayor**, at Town Hall — overseeing
  the task the way the Mayor oversees the village.
- Each **Agent team** member gets their own villager, chosen from the same
  19-role roster by matching their role name/instructions against keywords
  (a "Backend" role becomes the Blacksmith, a "Researcher" becomes the Scout,
  a "Reviewer" becomes the Judge, and so on — anything unrecognized still
  gets a stable, consistent villager rather than defaulting to one spot).

The full roster, with the building each stands at: Mayor (Town Hall),
Architect (Castle), Blacksmith (Blacksmith), Carpenter (Carpenter),
Librarian and Miner (Library), Mage (Mage Tower), Painter (Windmill),
Alchemist and Healer (Workshop), Farmer (Farm), Merchant (Merchant),
Warehouse Keeper (Harbor), Messenger (Lighthouse), Guard Captain
(Observatory), Builder (Shipyard), Scout (Stable), Judge (Plaza), Innkeeper
(Market). Every role except Architect and Painter has its own 8-directional
character sprite (in `characters/`) that turns to face the way it's walking;
those two use an emoji badge instead since no art was provided for them.

While idle, villagers wander near their building doing small profession-
flavored things (reading, sweeping, stoking a forge...). Once a task starts,
they go inside — the building lights up, smokes, and shows an activity bar —
and they come back out to celebrate briefly when it finishes. Team hand-offs
send a messenger with a scroll walking between the two buildings. A feed
panel at the bottom shows what each villager last "said" (a short, in-
character line built from their actual task text/result/error, not
generic status text). Day/night is automatic based on your system clock,
with a toggle to force either — idle villagers turn in for the night, but
anyone still working keeps going.

This view is read-only and best-effort: closing it doesn't stop or affect
any run, and everything it shows resets when Obsidian restarts (nothing
about the village itself is saved to disk).

## Notes / limitations

- The **chat sidebar** is still non-streaming (the full reply arrives at
  once, not token-by-token) — it uses Obsidian's `requestUrl`. The **AI
  Agent** now streams via raw `fetch` with a readable stream instead, which
  works fine on desktop but is worth testing on mobile before relying on
  it — it automatically falls back to a normal request if streaming isn't
  available. Bringing the same streaming to the chat sidebar would be a
  straightforward follow-up if you want it.
- Conversation history is kept in memory per session only — it's cleared
  when you close Obsidian or click "Clear". Persisting chat history to a
  note or to plugin data would be a straightforward follow-up if you want
  it.
- `isDesktopOnly` is set to `false` since `requestUrl` works on mobile too,
  but you haven't tested this on the mobile app yet — worth a quick check
  if that matters to you.

## File map

- `manifest.json` — plugin metadata Obsidian reads to list/load the plugin.
- `main.js` — a lightweight bootstrap that loads `src/core/plugin.js`. All
  actual logic lives under `src/`, split by responsibility (providers,
  agents, tools, workflow, memory, ui) — see `ARCHITECTURE.md` for the full
  module map.
- `src/` — the plugin's code, organized into `core/`, `providers/`,
  `agents/`, `tools/`, `workflow/`, `memory/`, and `ui/`.
- `styles.css` — all styling (sidebar, agent log, and village scene), using
  Obsidian's theme CSS variables so it matches light/dark themes
  automatically.
- `village-map.jpg` — the background art for the Village view.
- `characters/<Role>/<direction>.png` — 8-directional sprite art (north,
  north-east, east, south-east, south, south-west, west, north-west) for
  every villager role except Architect and Painter.
