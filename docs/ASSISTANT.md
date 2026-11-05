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
- **A small multi-agent team.** A lead routes each turn to one to four specialists: Guide,
  Projects, Data and Platform. Each specialist has a domain prompt and a subset of the tools. If
  more than one answers, the lead synthesises one reply. `SKIFF_ASSISTANT_MAX_AGENTS` caps the
  fan-out (default 3).
- **A UI channel.** Besides the MCP tools, every agent gets `guide_user`. The browser sends a
  compact outline of the current page (`data-skiff-target` ids plus headings, buttons, links, tabs
  and inputs with CSS selectors). The agent can navigate to a path and spotlight an element, one
  step at a time.
- **Optional.** No provider means no launcher and the chat endpoint answers `503`.

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
SKIFF_ASSISTANT_ROUTER_MODEL=gpt-4.1-nano   # optional; defaults to MODEL
SKIFF_ASSISTANT_API_KEY=sk-...
SKIFF_ASSISTANT_MAX_AGENTS=3                # 1–4
SKIFF_ASSISTANT_DISABLED=1                  # emergency off switch
```

On an installed host the dashboard writes these through `skiff-platform-config` (the same
owner-only, validate-then-restart path as email and backups, [OPS.md §4.3](./OPS.md)). On a dev
server they go to `.data/platform-settings.json` and apply after a restart.

The API key is write-only: it is never sent back to the browser, and a blank field in the form
keeps the saved one.

### Agent details (owner only)

Below the provider panel, **Agent details** edits each specialist: display name, the one-line
description the lead uses for routing, the full system prompt, an optional model override, and the
exact MCP tools it may call. Agents can also be disabled without losing their details, and each can
be reset to the built-in defaults.

These values live in the `settings` table under one JSON key (`assistant.agents.v1`), not in the
environment or a release file, so a change applies to the next turn without restarting the control
plane. Reads are lenient (a malformed row falls back to defaults); writes are validated against the
current tool catalog and audited as `platform.assistantAgent` (and
`platform.assistantAgentReset`). Only the owner can see or change this page; non-owners only receive
the display labels needed to render the chat.

## A turn

```
browser ── POST /api/v1/assistant/chat ──► lead router (1 model call)
                                              │
                    ┌─────────────────────────┼─────────────────────────┐
                    ▼                         ▼                         ▼
              Guide agent               Projects agent             Data agent …
           (tools + guide_user)          (tools only)              (tools only)
                    │                         │                         │
                    └───────────── text, tool activity, UI events ─────► SSE
                                              │
                                   if >1 answer: lead synthesis
```

1. The router sees the page outline, the last eight messages and the user message, and returns
   `{"agents":["projects","platform"],"reason":"…"}`. If the router model fails, a deterministic
   keyword fallback picks agents so the turn still works.
2. Each specialist runs its own tool loop (at most 8 model rounds and 16 tool calls). Tool results
   are truncated before they go back into context; logs and site content are treated as data.
3. The lead synthesises when more than one specialist answered. A single answer streams directly.
4. The stream is Server-Sent Events: `run.started`, `agent.started`, `text.delta`,
   `tool.started`, `tool.finished`, `ui.guide`, `confirmation.required`, `agent.finished`,
   `run.finished`, `error`. The contract is `packages/contracts/src/assistant.ts`.

The browser can cancel a run; `request.signal` aborts the upstream provider request.

## Guardrails

- **Same service layer.** Tools call `packages/core`; RBAC is checked there. A viewer cannot deploy
  because the tool exists; they get the same `ForbiddenError` the dashboard would.
- **Destructive actions need a click.** The runner never executes a tool annotated
  `destructiveHint: true`. It mints a short-lived HMAC token bound to the user, org, tool and exact
  arguments, and the chat shows a Confirm/Cancel card. `/api/v1/assistant/confirm` verifies the
  token and then runs the tool through the normal handler. The token expires in 10 minutes.
- **Audit.** The tool wrapper records `assistant.<tool>` with args (inline file bodies summarised,
  never stored) and the result. The turn itself records `assistant.chat` with the agents and page,
  not the full message.
- **No credentials.** Database and storage credentials are not MCP tools; the model never receives
  them. Tool output can still contain project names, URLs and log lines, so point the base URL at a
  provider you trust.
- **Bounded input.** One message is at most 8,000 characters, history is at most 30 messages, the
  page outline is at most 120 targets, and a user gets 12 turns a minute.
- **Prompt injection.** Tool output and page text are labelled as data in every agent prompt. The
  assistant has no shell and no arbitrary HTTP tool; the only non-MCP tool drives the UI tour.

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
| "Routed from keywords…" | The router model failed; the turn still ran with a heuristic |
| "The model provider timed out" | No response within 120 s |
| A tour step says the element is not on the page | The page changed, the element is hidden, or the user lacks access |
| Destructive card never appears | The action was not marked destructive; check the tool annotations |

## Code map

| Path | Role |
|---|---|
| `packages/contracts/src/assistant.ts` | Page outline, chat request, tour, event and status types |
| `apps/control-plane/src/lib/server/mcp.ts` | `skiffToolDefinitions()` captures the MCP catalog |
| `apps/control-plane/src/lib/server/assistant/agents.ts` | Prompts and per-agent tool allowlists |
| `apps/control-plane/src/lib/server/assistant/orchestrator.ts` | Routing, tool loops, synthesis, confirmations |
| `apps/control-plane/src/lib/server/assistant/provider.ts` | OpenAI-compatible streaming client |
| `apps/control-plane/src/lib/server/assistant/openrouter.ts` | OpenRouter catalogue (tool-capable models, prices) for the picker |
| `apps/control-plane/src/lib/server/assistant/settings.ts` | Owner-edited agent details in the `settings` table |
| `apps/control-plane/src/routes/api/v1/assistant/*` | Status, chat stream and confirm endpoints |
| `apps/control-plane/src/lib/assistant/*` | Chat state, page outline, panel, launcher, tour and the OpenRouter model picker |
| `apps/control-plane/src/routes/(dashboard)/settings/assistant` | Owner-only setup |
