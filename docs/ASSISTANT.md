# The dashboard assistant

An optional chat panel inside the Skiff dashboard. It answers questions about the current page and
the whole platform, drives the same MCP tools your agents use, and can move the user around the UI
with a spotlight tour. It is **off until an owner configures a model provider** in Settings →
Assistant.

The design goal is narrow: one more surface over `packages/core`, never a second execution path.
The assistant cannot do more than the signed-in user, and every action is audited.

## What it is

- **A chat surface over the MCP catalog.** `skiffToolDefinitions()` captures the exact tool
  definitions the remote MCP server registers, and the assistant calls those handlers. Tool names,
  schemas, validation, permissions and results are the same on both surfaces.
- **One agent with every tool.** Each turn runs a single tool loop with one system prompt that
  covers dashboard help, projects, data and the platform, and every MCP tool the signed-in user may
  call. A question that spans areas is answered in one pass; there is no routing step and no
  merging of partial answers. An owner can narrow the tool list (see below).
- **Tool search.** The catalog is well over a hundred tools, so when a turn has more than 40 the
  model starts with a core set of reads (`whoami`, docs, projects, deployments, logs, status,
  databases, storage, nodes, `guide_user`) plus `search_tools`. The prompt lists every other tool
  by name only; `search_tools` takes keywords or `select:name1,name2` and loads the matches, which
  are callable from the next model round of the same turn. A call to a tool that was never loaded
  is not run: it is loaded and the model is told to call it again with the schema. This only saves
  context; it is not a permission boundary (the catalog is already filtered to what the caller may
  use). An owner allowlist of 40 tools or fewer is offered whole, with no search tool.
- **A UI channel.** Besides the MCP tools, the assistant gets `guide_user`. The browser sends a
  compact outline of the current page (`data-skiff-target` ids plus headings, buttons, links, tabs
  and inputs with CSS selectors). The assistant can navigate to a path and spotlight an element, one
  step at a time.
- **Optional.** No provider means no launcher and the chat endpoint answers `503`.

## The chat panel

The panel is a non-modal side panel (⌘I), so the dashboard stays usable while it is open. From the
⋯ menu it can go **wide** (640 px) or **dock** beside the page on screens 1024 px and wider; docking
narrows the page instead of covering it.

- **Conversations persist** per user in this browser's `localStorage` (40 at most, pinned ones are
  kept first). The history view searches, pins, renames and deletes them; the empty state offers the
  three most recent. Nothing about the conversation is stored on the server beyond the audit trail.
  Drafts are kept per conversation.
- **Markdown replies.** `markdown.ts` parses a safe subset (paragraphs, lists, code fences with a
  copy button, tables, quotes, bold/italic/inline code, links) into tokens that Svelte renders as
  elements. There is no `{@html}` on this path. Links are limited to relative dashboard paths (which
  navigate in place) and `http(s)` URLs (new tab, `noopener`). The assistant is told this subset
  in `PANEL_FORMAT`, which is appended to the prompt, an owner-edited one included.
- **Each turn shows its own work.** Tool steps attach to the reply that made them: a running
  line while it works, then a collapsible list with status, duration, the arguments (file bodies
  summarised) and a result excerpt. Confirmation cards attach to the reply that proposed them, show
  the arguments as fields, and stay in the scrollback with their outcome.
- **Recovery.** Stop keeps the partial reply. Regenerate re-runs the latest turn; Edit (or ↑ on an
  empty composer) loads a message back into the composer and replaces that turn and everything after
  it. A failed turn shows the reason inline with Try again. A dropped stream is reported, not left
  spinning.
- **Composer.** Autosizing; Enter sends, Shift+Enter adds a newline, IME composition is respected;
  you can type the next message while a reply streams. `/` opens commands (`/new`, `/history`,
  `/retry`, `/clear`, `/export`, `/status`, `/tour`, `/help`). `@` autocompletes projects, databases
  and storage instances from the user's own `GET /api/v1/{projects,databases,storage}` and inserts
  `@name`, which the assistant resolves with tools.
- **Page context is visible and optional.** A chip under the composer shows which page is shared.
  Turning it off sends an empty `path` and no outline; the assistant is told it cannot see the page.
- **Outcomes reach the model.** When history is sent, each past reply carries a line saying what
  happened to its proposed action (confirmed and the result, cancelled, failed or expired) and
  whether the user stopped it early. After an action completes, **Ask Skiff to follow up** sends a
  verification message.
- **Contextual questions.** A firing or no-data series on Alerts has **Ask AI**, which opens the
  panel with the rule, series, value and duration already written out and asks the assistant to
  explain the cause and next steps. It respects the page-context preference.
- Also: copy on every message, timestamps, turn duration, a jump-to-latest pill when you have scrolled up, an unread dot on the launcher when a
  reply finishes while the panel is closed, and Export as Markdown.

## Setup

Settings → Assistant is owner-only, like Settings → Backups and Notifications. It accepts any
OpenAI-compatible chat-completions endpoint:

| Provider | Base URL | Notes |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | API key required |
| OpenRouter | `https://openrouter.ai/api/v1` | API key required. The model field is a searchable picker built from OpenRouter's catalogue, filtered to models that advertise tool calling |
| vLLM / LM Studio / another compatible gateway | your `/v1` URL | API key if the gateway needs one; type the model id |
| Ollama | `http://127.0.0.1:11434/v1` | Usually no key; set the model to a pulled model |

The **Test provider** button (and every save) calls `GET <baseUrl>/models` before saving, so a
wrong URL or key fails in the form rather than at the first chat turn. With **OpenRouter** selected
the model field switches to a searchable list from `GET https://openrouter.ai/api/v1/models`,
showing context length and per-million-token prices and hiding models that cannot call tools. That
list is fetched by the owner-only `GET /api/v1/assistant/models` route, cached for ten minutes, and
never loaded on ordinary dashboard pages.

The same settings can be set in the environment on a host that is not managed by the dashboard:

```sh
SKIFF_ASSISTANT_PROVIDER=openai-compatible  # openai | openai-compatible | openrouter | ollama
SKIFF_ASSISTANT_BASE_URL=https://api.openai.com/v1
SKIFF_ASSISTANT_MODEL=gpt-4.1-mini
SKIFF_ASSISTANT_API_KEY=sk-...
SKIFF_ASSISTANT_DISABLED=1                  # emergency off switch
```

On an installed host the dashboard writes these through `skiff-platform-config` (the same
owner-only, validate-then-restart path as email and backups, [OPS.md §4.3](./OPS.md)). On a dev
server they go to `.data/platform-settings.json` and apply after a restart.

The API key is write-only: it is never sent back to the browser, and a blank field in the form
keeps the saved one.

### Instructions and tools (owner only)

Below the provider panel, **Instructions and tools** edits the assistant: the full system prompt,
an optional model override, and which MCP tools it may call. **Every tool** is the default and
includes tools added in later releases; turning it off picks an exact allowlist. **Reset** returns
everything to the built-in defaults.

These values live in the `settings` table under one JSON key (`assistant.agent.v1`), not in the
environment or a release file, so a change applies to the next turn without restarting the control
plane. Reads are lenient (a malformed row falls back to defaults); writes are validated against the
current tool catalog and audited as `platform.assistantAgent` (and
`platform.assistantAgentReset`). Only the owner can see or change this page.

## A turn

```
browser ── POST /api/v1/assistant/chat ──► assistant (system prompt + page outline + history)
                                              │   ▲
                                    tool calls│   │results (MCP handlers, guide_user)
                                              ▼   │
                                          tool loop ── text, tool activity, UI events ──► SSE
```

1. The assistant sees its system prompt, the history, the page outline and the user message, with
   every tool it may call (or the owner's allowlist).
2. It runs one tool loop: at most 12 model rounds and 24 tool calls by default, set in
   Settings → Assistant → Turn limits (`assistantMaxRounds`, 1–50; `assistantMaxToolCalls`, 1–200). A
   `search_tools` call spends one round. Tool results are truncated
   before they go back into context; logs and site content are treated as data. The reply streams
   as it is written.
3. The stream is Server-Sent Events: `run.started`, `text.delta`, `tool.started` (with an
   argument preview), `tool.finished` (summary, a ≤4,000-character result excerpt and
   `durationMs`), `ui.guide`, `confirmation.required`, `run.finished` (with `durationMs`), `error`.
   The contract is `packages/contracts/src/assistant.ts`.

The browser can cancel a run; `request.signal` aborts the upstream provider request.

## Guardrails

- **Same service layer.** Tools call `packages/core`; RBAC is checked there. A viewer cannot deploy
  because the tool exists; they get the same `ForbiddenError` the dashboard would.
- **Destructive and production-changing actions need a click.** The runner never executes a tool
  annotated `destructiveHint: true`, or one in the server-side `CONFIRM_TOOLS` list
  (`assistant/confirm-policy.ts`): access changes, share links, presigned URLs, deploy, promote and
  rollback, workload changes, credential rotation, restores and restarts. The model reads
  untrusted text (logs, page content, rows), so an injected instruction must not be able to publish
  a site or mint a link on its own. Arguments are parsed with the tool's schema before anything
  runs. It mints a short-lived HMAC token bound to the user, org, tool and exact
  arguments, and the chat shows a Confirm/Cancel card. `/api/v1/assistant/confirm` verifies the
  token and then runs the tool through the normal handler. The token expires in 10 minutes.
- **Audit.** The tool wrapper records `assistant.<tool>` with args (inline file bodies summarised,
  never stored) and the result. The turn itself records `assistant.chat` with the message length and
  page, not the full message.
- **No credentials.** Database and storage credentials are not MCP tools; the model never receives
  them. Tool output can still contain project names, URLs and log lines, so point the base URL at a
  provider you trust.
- **Bounded input.** One message is at most 8,000 characters, history is at most 30 messages, the
  page outline is at most 120 targets, and a user gets 12 turns a minute.
- **Prompt injection.** Tool output and page text are labelled as data in the prompt. The
  assistant has no shell and no arbitrary HTTP tool; the only non-MCP tools drive the UI tour and
  load deferred MCP tools (`search_tools`).

## Guided tours

`guide_user` takes 1–8 steps:

```json
{
  "intro": "Deploy is the orange button in the project header.",
  "steps": [
    { "path": "/projects/launch-page", "target": "project.deploy", "title": "Deploy", "body": "Open Deploy and choose an environment." }
  ]
}
```

The browser resolves `target` against `[data-skiff-target]`, then falls back to `selector`, waits
for client-side navigation and deferred rendering, scrolls the element into view and draws a
spotlight. `data-skiff-target` ids exist on the sidebar, page headers, project tabs, settings tabs
and the Deploy button; everything else is collected dynamically with a CSS selector, so the guide
works on pages that have not been annotated.

## Failure modes

| Symptom | Cause |
|---|---|
| No launcher, `503 assistant_not_configured` | Base URL or model is missing, or `SKIFF_ASSISTANT_DISABLED=1` |
| "The model provider answered 401/404" | Wrong key, wrong base URL, or the model id is not served there |
| "The model provider timed out" | No response within 120 s |
| A tour step says the element is not on the page | The page changed, the element is hidden, or the user lacks access |
| Destructive card never appears | The action was not marked destructive; check the tool annotations |

## Code map

| Path | Role |
|---|---|
| `packages/contracts/src/assistant.ts` | Page outline, chat request, tour, event and status types |
| `apps/control-plane/src/lib/server/mcp.ts` | `skiffToolDefinitions()` captures the MCP catalog |
| `apps/control-plane/src/lib/server/assistant/agents.ts` | The system prompt and `PANEL_FORMAT` |
| `apps/control-plane/src/lib/server/assistant/orchestrator.ts` | The tool loop and confirmations |
| `apps/control-plane/src/lib/server/assistant/tool-search.ts` | Deferred tool loading: core set, `search_tools`, ranking |
| `apps/control-plane/src/lib/server/assistant/provider.ts` | OpenAI-compatible streaming client |
| `apps/control-plane/src/lib/server/assistant/openrouter.ts` | OpenRouter catalogue (tool-capable models, prices) for the picker |
| `apps/control-plane/src/lib/server/assistant/settings.ts` | Owner-edited instructions, model and tool allowlist in the `settings` table |
| `apps/control-plane/src/routes/api/v1/assistant/*` | Status, chat stream and confirm endpoints |
| `apps/control-plane/src/lib/assistant/assistant.svelte.ts` | Chat state, persisted conversations, turns, regenerate/edit, confirmations |
| `apps/control-plane/src/lib/assistant/markdown.ts`, `Markdown.svelte` | Safe Markdown subset for replies |
| `apps/control-plane/src/lib/assistant/*.svelte` | Panel, composer (slash commands, mentions), messages, tool steps, confirmation cards, history, launcher, tour, model picker |
| `apps/control-plane/src/routes/(dashboard)/settings/assistant` | Owner-only setup |
