# Writing Skiff documentation

User-facing documentation for Skiff lives in `content/` as Markdown, one file per page. The same
files render in two places: the dashboard's **Docs** page (`/docs` on the control plane) and the
standalone docs site (`apps/docs`, deployable on its own). `src/manifest.ts` decides the sidebar
order; a page that is not in the manifest is not published.

`docs/` at the repository root is different: those are design documents and decision logs for
people building Skiff. They are excellent research sources, but user docs explain **how to use
and run Skiff**, not why it was designed that way.

## Audience

- **Users** deploying sites, functions, apps and data services through the dashboard, the `skif`
  CLI, the REST API or an AI agent over MCP.
- **Operators** self-hosting Skiff on their own server(s).

Write for a competent developer who has never seen Skiff. Lead with what they want to do, then
show how. Explain a concept once, in the page that owns it, and link to it elsewhere.

## File format

```markdown
---
title: Static sites
description: Deploy a folder of files, get a preview URL, then promote or roll back instantly.
---

Opening paragraph: what this page covers and when you'd use it (2–4 sentences).

## First section

…
```

- `title` (required): short, Title-less-case ("Static sites", not "Deploying Static Sites").
- `description` (required): one sentence, at most ~160 characters; shown under the title and in
  search results.
- **No `#` H1 in the body.** The title is rendered from the frontmatter. Use `##` for sections
  and `###` for subsections; avoid `####` and deeper.

## Markdown you can use

- Paragraphs, lists, **bold**, *italic*, `inline code`, tables, horizontal rules.
- Fenced code blocks **with a language**: `sh`, `ts`, `js`, `json`, `jsonc`, `yaml`, `toml`, `sql`,
  `ini`, `dotenv`, `python`, `html`, `css`, `dockerfile`, `diff`, `http`, `text`. Use `sh` for
  terminal commands; don't prefix commands with `$`.
- Callouts (GitHub syntax), sparingly:

  ```markdown
  > [!NOTE]
  > Useful background the reader might miss.

  > [!TIP]
  > A shortcut or better way.

  > [!WARNING]
  > Something that can break things or lose data.
  ```

  Also available: `[!IMPORTANT]` and `[!CAUTION]`.

- **Diagrams** use Mermaid in a ```` ```mermaid ```` fence. They render as themed SVG in both the
  dashboard and the standalone site (light and dark), and the page checker fails on a diagram
  that doesn't parse. Use one where a flow, a sequence of calls between components, a lifecycle or
  an architecture is easier to see than to read, usually next to the prose it illustrates:

  ```mermaid
  sequenceDiagram
    participant CLI as skif CLI
    participant CP as Control plane
    participant Agent as Node agent
    CLI->>CP: create upload, PUT zip, finalize
    CP-->>CLI: preview URL
    Agent->>CP: long-poll desired state
    CP-->>Agent: new release
  ```

  Rules: `flowchart LR`/`TD`, `sequenceDiagram` or `stateDiagram-v2`; at most about 12 nodes or 10
  messages; short labels, quoted when they contain punctuation (`A["Caddy (edge)"]`); no HTML,
  `<br>`, `classDef`, `style`, colours or `%%{init}%%` directives (the theme handles styling).
  Every arrow must reflect what the code actually does. Prefer a diagram over an ASCII drawing.
- **Links to other docs pages** use the page slug as an absolute path: `[promote a
  deployment](/deploying/static-sites#promote-and-roll-back)`. Only slugs listed in
  `src/manifest.ts` are valid; the build fails on a broken docs link. Heading anchors are the
  heading text lower-cased with spaces turned into `-` and punctuation removed.
- External links use full `https://` URLs. Do **not** link to files in the repository or to
  `docs/*.md` design documents.
- Refer to dashboard locations in bold with arrows: **Settings → Backups**, **Projects → my-site →
  Deployments**. Don't link to dashboard URLs.
- No raw HTML, no images, no emoji.

## Style

- British spelling, matching the codebase (organisation, behaviour, colour). Plain, direct
  sentences; second person ("you"); present tense.
- Product name **Skiff**. The CLI binary is **`skif`** (`skiff` is an alias). The package is
  `@skiffy/skiff`.
- Prefer concrete examples: a real command with real flags, a real `skiff.json`, a real REST call
  with `curl`. Use `example.com`, `control.example.com`, `my-site`, `skif_…` as placeholders.
- Tables are great for reference material (flags, env vars, permissions, limits).
- Don't cite internal decision numbers (D42), wave names, plan files, or test names.
- Don't pad. No "In this guide we will…", no closing summaries. A page is usually 600–1,800
  words; reference pages (CLI, API, configuration) may be longer.

## Accuracy is the job

Every command, flag, environment variable, permission name, API route, MCP tool, file name,
default and limit you write must be **checked against the source code**, not just against a
design document. Design docs can describe plans that were never built or that changed.

- Read the design doc for the big picture, then confirm details in `apps/*` and `packages/*`
  (contracts in `packages/contracts/src`, behaviour in `packages/core/src`, CLI in
  `apps/cli/src`, REST routes in `apps/control-plane/src/routes/api/v1`, dashboard pages in
  `apps/control-plane/src/routes/(dashboard)`).
- If a feature is designed but not implemented, either leave it out or say so plainly in a
  `> [!NOTE]` ("Not available yet: …"). Never document an invented flag or endpoint.
- If you're not sure about a detail, leave it out rather than guess.
