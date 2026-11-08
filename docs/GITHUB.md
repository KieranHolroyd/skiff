# Skiff — GitHub App

Status: **built 2026-11-08** (§2 → D163, §3 → D164, §4 → D165, §5 → D166). What is not built is
listed in §8. User documentation: `packages/docs/content/deploying/github.md`.

Skiff talked to GitHub in five places, each with its own credential and setup step: git builds
(a per-project webhook plus a node-wide `SKIFF_GIT_TOKEN`), pipelines (a per-repository webhook,
node credentials and an optional status token), runner pools (a PAT or a pasted App key per
project), registry OIDC trusts (a typed `owner/repo`) and sign-in (a separate OAuth app in the
environment). This document adds one **GitHub App per install** that all of them use when it
covers a repository, and leaves every old path working for repositories it does not.

---

## 1. Summary

| What | Where | Decision |
|---|---|---|
| Register the App by GitHub's manifest flow, or paste an existing App | Settings → GitHub (platform admin) | D163 |
| Link each installation to one Skiff org after GitHub confirms the installer can see it | Settings → GitHub (org owner/admin) | D163 |
| Clone private repositories with a one-hour, single-repository token per build/job | build claim `auth`, pipeline claim `gitToken` | D164 |
| `secrets.GITHUB_TOKEN` for trusted pipeline jobs | `PipelineEngine.secrets` | D164 |
| Commit statuses for builds and runs; GitHub deployments for builds | `GithubAppService.commitStatus` / `deployment` | D164 |
| One App webhook for every repository; hand-made webhooks for covered repos ignored | `/api/webhooks/github-app` | D165 |
| Runner pools authenticate with the installation (`auth.method: installation`) | `GithubRunnerService` | D165 |
| Repository pickers in the git source, pipeline repository and registry trust forms | `GET /api/v1/github/repositories`, `GithubRepoPicker.svelte`, MCP `list_github_repositories` | — |
| "Sign in with GitHub" falls back to the App's OAuth client | `auth.ts` at boot | D166 |

## 2. Registration and installations (D163)

**The App.** `GithubAppService.startManifest` returns the manifest (`githubAppManifest` in
`@skiff/contracts`) and the URL to post it to (`github.com/settings/apps/new` or an organisation's
equivalent), with an HMAC-signed `state` bound to the admin. GitHub redirects to
`/settings/github/created?code&state`; `completeManifest` exchanges the code
(`POST /app-manifests/{code}/conversions`) for the App id, slug, PEM, webhook secret and OAuth
client. `configureManual` takes the same fields pasted from an existing App and proves the key with
`GET /app`. Everything secret is stored in `settings` row `github.app`, sealed with the `platform`
data key (as the registry does), so `skiff-rotate-master-key` re-wraps it with the other DEKs.

The manifest asks for *Contents: read*, *Metadata: read*, *Pull requests: read*, *Commit statuses:
write*, *Deployments: write*, *Administration: write*, *Self-hosted runners: write (org)* and the
account permission *Email addresses: read*, and subscribes to `push` and `pull_request`. It sets
`request_oauth_on_install`, with `/settings/github/installed` as the first callback URL and
`/api/auth/callback/github` as the second.

**Installations.** `github_installations` (migration 0077) keys on GitHub's installation id and
holds the account, repository selection, granted permissions, suspension and the linked `org_id`
(null while unclaimed). Rows come from the App webhook, from `syncInstallations`
(`GET /app/installations`, which also deletes rows GitHub no longer lists) and from the install
callback.

**Linking.** The install URL carries a signed `state` bound to the user and org. GitHub returns to
`/settings/github/installed?installation_id&setup_action&code&state`. `completeInstallation`
requires an org owner or admin in an interactive session, verifies the state, exchanges `code` for
the installer's user token and requires `GET /user/installations` to list the installation. Only
then is the row linked, and only if no other org holds it. Without an OAuth client (a pasted App
without client credentials), only a platform admin may link, which is also how unclaimed rows are
adopted (`linkInstallation`). `unlinkInstallation` clears `org_id` and drops cached tokens.

## 3. Tokens, statuses and deployments (D164)

`installationToken(id, { repositories?, permissions? })` mints with the App JWT
(`githubAppJwt`, RS256, nine minutes) and caches per `(installation, repositories, permissions)`
until five minutes before expiry. Callers never handle installations:

- `repoToken(orgId, repoUrl, permissions)` → the org's installation on the URL's owner, narrowed to
  that repository; `null` (never a throw) when the URL is not github.com, nothing covers it or
  GitHub refuses (then not retried for a minute).
- `ownerToken(orgId, owner, { repo?, permissions })` → for runner pools; throws a message the
  Worker card can show.

| Use | Permissions | Path |
|---|---|---|
| Git build clone | contents: read | `BuildService.claim` → `BuildJob.auth = { username: 'x-access-token', password }` |
| Pipeline resolve and job clone | contents: read | `PipelineEngine.claim` → `gitToken` |
| `secrets.GITHUB_TOKEN` (trusted jobs only) | contents: read, statuses: write, pull_requests: read | `PipelineEngine.secrets`, listed in `secretNames` |
| Build status `skiff-build/<project>` | statuses: write | `BuildService.reportGithub` on queue, claim result, cancel |
| Run status `skiff/<workflow>` | statuses: write | `PipelineEngine.reportStatus` (a stored status token still wins) |
| GitHub deployment | deployments: write | succeeded build: environment `<project>` (production, `auto_inactive`) or `<project>-preview` |

On the Builder, `withCloneToken` swaps the token in for that clone only (`gitAuthEnv` header,
`github.com` only), the masker and `redactSecret` cover it, and `job.json` (readable by steps) is
written with `gitToken: null`.

## 4. Events (D165)

`handleWebhook` verifies `X-Hub-Signature-256` with the App's secret, then:

- `installation` (`created`, `deleted`, `suspend`, `unsuspend`, `new_permissions_accepted`) and
  `installation_repositories` upsert or delete the row and drop cached tokens and repository lists;
- `push` / `pull_request` from a linked, unsuspended installation → `BuildService.handleAppPush`
  (pushes only) and `PipelineService.handleAppEvent`, which select the org's enabled git sources and
  pipeline repositories whose URL parses to the same `owner/repo` (case-insensitive);
- an unknown installation triggers `syncInstallations` and is ignored until linked.

The per-project (`/api/webhooks/github/<project>`) and per-repository
(`/api/webhooks/pipelines/<id>`) webhooks still verify their own secrets, then call
`deliversFor(orgId, owner/repo)`: true when the installation selects all repositories or its cached
list (two minutes) contains the repository. Then they accept and ignore the delivery. When GitHub
cannot be asked the answer is false.

## 5. Sign-in (D166)

`auth.ts` computes `github ?? core.githubApp.oauthCredentials()` once at module load and passes it
to Better Auth's GitHub provider; the login and setup pages read `githubSignIn`. Settings → GitHub
says which source is in use.

## 6. Surfaces

- **Dashboard.** Settings → GitHub (`/settings/github`): App panel (create, paste, update, remove),
  installations (install, choose repositories on GitHub, disconnect), platform-admin view of
  unclaimed and other-org installations with Sync and Link here, and what the App does. Callback
  pages `/settings/github/created` and `/settings/github/installed` redirect back or show the error.
- **Pickers.** `GithubRepoPicker.svelte` (TanStack Query over `GET /api/v1/github/repositories`) in
  the pipeline repository dialog, the project git source dialog and the registry trust dialog.
  `GitSourceView` and `PipelineRepositoryView` carry `githubAppInstallationId`, which switches the
  webhook and status-token copy to "delivered by the GitHub App".
- **REST.** `GET /api/v1/github/app`, `/installations`, `/repositories[?refresh=1]`.
- **MCP.** `list_github_repositories` (read-only, `build:read`).
- **Runner template.** "Authenticate with" offers **Skiff's GitHub App**; the plan builds
  `auth: { method: 'installation' }` and creates no secret. `WorkloadService` refuses the spec when
  the org has no installation on the owner.

## 7. Security notes

- The App key never leaves the control plane; nodes and jobs only ever see narrowed installation
  tokens that expire within an hour.
- Untrusted pipeline runs (fork pull requests, inline workflows) still clone with a read-only token
  for the one repository, but the token is not in their `job.json`, environment or secrets.
- Linking needs GitHub's confirmation through the installer's own OAuth token, or a platform admin.
- The App webhook rejects unsigned deliveries (D45 holds), and an unlinked or suspended installation
  starts nothing.

## 8. Not built

- Check runs, pull request comments with preview URLs, and PR preview deployments for git builds.
- Private remote actions (`uses: owner/private-repo@ref`) with the App token: the job token is
  narrowed to the run's repository; `ACTIONS_GITHUB_TOKEN` remains the way.
- Self-update and node update downloads still read GitHub Releases anonymously.
- GitHub Enterprise Server (API and web base URLs are fixed to github.com).
- A CLI command; the REST endpoints and MCP tool cover scripts and agents.
