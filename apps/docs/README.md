# Skiff docs site

The standalone build of Skiff's user documentation: plain static HTML, CSS and a small script,
deployable to any static host, including Skiff itself.

The pages come from [`packages/docs/content`](../../packages/docs/content), the same Markdown the
dashboard renders at `/docs` and the MCP server indexes for `search_docs` / `read_docs`. Write
and edit pages there, following [`packages/docs/WRITING.md`](../../packages/docs/WRITING.md).

```sh
bun run docs:dev                     # http://localhost:4321, rebuilds on every change
bun run docs:check deploying/static-sites   # check one page (links, frontmatter, diagrams)
bun test packages/docs               # check every page and the search index
bun run docs:build                   # → apps/docs/dist
```

## Deploying

On Skiff, from the repository root:

```sh
bun run docs:build
skif deploy apps/docs/dist --project skiff-docs
```

The build writes a `skiff.json` (`trailingSlash: "always"`, `notFound: "/404.html"`), and every
asset has a content hash in its name, so Skiff serves it with immutable caching.

On another host, deploy `dist/` as-is. Options:

| Flag | Env | Purpose |
| --- | --- | --- |
| `--out <dir>` | | Output directory (default `dist`) |
| `--base <path>` | `DOCS_BASE` | Serve under a path prefix, e.g. `/skiff/` for GitHub Pages |
| `--site-url <url>` | `DOCS_SITE_URL` | Public origin, adds canonical links, `sitemap.xml` and `robots.txt` |

## Staying current

[`.github/workflows/docs.yml`](../../.github/workflows/docs.yml) checks and builds the site on every
change to the docs or the platform `VERSION`, and deploys it to Skiff when `vars.SKIFF_DOCS_URL`
and `secrets.SKIFF_DOCS_TOKEN` are set. The in-dashboard docs and the agents' search index need
nothing: they are bundled into each control-plane build, so a platform update brings the docs for
the version it installs.

## How it works

- `src/build.ts` renders every page with `@skiff/docs` (Markdown → HTML, Shiki highlighting,
  callouts, heading anchors, link checking) into `<slug>/index.html`, plus a home page, a 404 page
  and `search.json`.
- `src/client.ts` adds search (`/` or ⌘K), the theme toggle, the mobile menu, copy buttons and
  the "On this page" highlight. Mermaid diagrams are rendered by a lazily loaded chunk, only on
  pages that have one; without JavaScript they show as source.
- `src/site.css` mirrors the dashboard's theme tokens; page typography is shared from
  `@skiff/docs/prose.css`.
