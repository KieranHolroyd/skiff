---
title: GitHub App
description: Connect GitHub once for private clones, push and pull request events, commit statuses, deployments and runners, with no tokens or webhooks.
---

Skiff can register its own GitHub App. Once your GitHub account or organisation installs it, everything in Skiff that talks to GitHub uses the installation instead of tokens and webhooks you set up by hand. This page covers creating the App, installing it, what it changes for git builds, pipelines, runners and the registry, and how it stays safe.

You don't need the App. Without it, git builds and pipelines work with hand-made webhooks and node credentials, as described in [Git builds](/deploying/git-builds) and [Pipelines](/deploying/pipelines).

## What the App does

Each feature applies to every repository the installation can see. Repositories it cannot see keep working the old way.

| Area | With the App |
| --- | --- |
| Private repositories | Builder nodes clone with a one-hour, read-only token for that one repository, minted for each build or job. No `SKIFF_GIT_TOKEN` is needed on the node. |
| Events | Pushes and pull requests reach every git build and pipeline repository that names the repository. You don't add a webhook or a webhook secret. |
| Commit statuses | Git builds report `skiff-build/<project>` and pipeline runs report `skiff/<workflow>` on the commit, linking back to Skiff. |
| Deployments | A promoted git build appears under the repository's **Deployments** as environment `<project>` with the production URL. A preview build appears as `<project>-preview`. |
| `GITHUB_TOKEN` | Trusted pipeline jobs get `secrets.GITHUB_TOKEN`: a token for that repository only, with *Contents: read*, *Commit statuses: write* and *Pull requests: read*. |
| Runners | A [GitHub Actions runner](/deploying/git-builds#github-actions-runners) pool can authenticate with **Skiff's GitHub App** instead of a personal access token or a pasted App key. |
| Pickers | The git source, pipeline repository and registry trust forms list your repositories, so you pick one instead of typing a URL. |
| Sign-in | The App's OAuth client also powers **Sign in with GitHub**, unless `GITHUB_CLIENT_ID` is set in the environment. |

## Create the App

A platform admin does this once per Skiff install.

1. Open **Settings → GitHub** and choose **Create GitHub App**.
2. Enter a name. It must be unique across GitHub, and it is shown on commit statuses and deployments. To own the App with a GitHub organisation instead of your personal account, enter the organisation's name. You must be an owner of that organisation.
3. Tick **Installable by any GitHub account** if organisations in this Skiff use different GitHub accounts. Leave it unticked to keep the App installable only by its owner.
4. Choose **Continue to GitHub** and confirm on GitHub.

GitHub sends you back to Skiff with the App's ID, private key, webhook secret and OAuth client. Skiff stores the key and the secrets encrypted and never shows them again. The App asks GitHub for these permissions:

| Permission | Used for |
| --- | --- |
| Contents: read, Metadata: read | Cloning and reading workflow files |
| Pull requests: read | Pull request events for pipelines |
| Commit statuses: write | Build and run statuses |
| Deployments: write | GitHub deployments for git builds |
| Administration: write | Repository runners |
| Self-hosted runners: write (organisation) | Organisation runners |
| Email addresses: read (account) | Sign in with GitHub |

> [!NOTE]
> "Sign in with GitHub" through the App starts working after the next control-plane restart, because sign-in providers are loaded at boot.

### Use an existing App

If you already have a GitHub App, choose **Use an existing App** and paste its App ID, private key and webhook secret. The client ID and secret are optional. Without them, only platform admins can link installations, and sign-in through the App is off.

In the App's settings on GitHub, set:

- **Webhook URL:** `https://control.example.com/api/webhooks/github-app`, with the same webhook secret
- **Callback URL:** `https://control.example.com/settings/github/installed`, with **Request user authorization (OAuth) during installation** turned on. Add `https://control.example.com/api/auth/callback/github` as a second callback URL for sign-in.
- **Events:** Push and Pull request
- **Permissions:** the ones in the table above

## Install it

An organisation owner or admin installs the App for their Skiff organisation.

1. Open **Settings → GitHub** and choose **Install on GitHub**.
2. Pick the GitHub account or organisation, then choose **All repositories** or the repositories Skiff may use.
3. GitHub asks you to authorise the App and sends you back to Skiff.

Before it links the installation, Skiff asks GitHub, with your own authorisation, whether your GitHub account can see that installation. Nobody can link another account's repositories to their Skiff organisation by guessing an installation ID. One installation belongs to one Skiff organisation.

To add or remove repositories later, open the installation's menu and choose **Choose repositories on GitHub**. Pickers refresh within two minutes, or straight away with their refresh button.

Platform admins also see installations that are not linked to any organisation. That happens when the App was installed without the OAuth step, or when its webhook could not reach Skiff. An admin can link one to their current organisation with **Link here**. **Sync** fetches the current list from GitHub.

## Deploy from GitHub

**Projects → Deploy from GitHub** (also on **New**) lists the repositories the App can see, most recently pushed first. Choose **Import** on one and Skiff reads it:

- It picks a **framework preset**: Vite, Astro, SvelteKit, Next.js, Nuxt, Gatsby, Create React App, Docusaurus, VitePress, Eleventy, Hugo, a Bun or Node server, or plain HTML. The preset fills in the build command, the output directory and whether the project serves static files or runs a process app.
- For a monorepo, set the **root directory** (click a folder to step into it). Skiff detects the framework again for that directory.
- Under **Build and output settings** you can change the build command, output directory and runtime. A process app also takes a start command, port and plain environment variables.
- If the repository has workflows in `.skiff/workflows`, **Run its workflows in Pipelines** is ticked.

Choose **Deploy**. Skiff creates the project, connects the repository on the production branch, queues the first build and opens the project's Builds tab. The build is promoted when it succeeds. From then on every push to that branch builds and deploys. There is no webhook or deploy key to add on GitHub.

Agents can do the same with the MCP tool `deploy_from_github`, and scripts with `GET /api/v1/github/detect?repository=owner/name` followed by `POST /api/v1/github/import`.

Builds run with Bun on your Builder nodes, and Bun reads npm, Yarn and pnpm lockfiles. Password and Skiff Access protection are set on the project after the import.

## Git builds

Connect a repository as usual in **Projects → my-site → Builds**. When the App covers the repository:

- Pushes to the configured branch start a build, with no webhook. The project's own webhook URL still works for repositories the App can't see.
- If a repository also has a hand-made webhook, Skiff ignores it while the App delivers that repository's pushes. One push never starts two builds.
- Builder nodes clone private repositories with a token from the App.
- Every build reports a commit status, and a successful build records a GitHub deployment.

## Pipelines

You don't have to add repositories the App covers. Push a commit that contains a workflow in `.skiff/workflows`, and the repository appears under **Pipelines** and its workflows run. Skiff adds it on behalf of the person who connected the installation. Pull requests never add a repository, so a fork can't register one.

- To stop a repository from running, disable it in its settings. If you delete it instead, Skiff remembers that and does not add it back. **Settings → GitHub → Pipelines** lists these repositories, with **Allow again** for each one.
- Owners and admins can turn this off in **Settings → GitHub → Pipelines → Set up pipelines automatically**.

You can still add a repository by hand under **Pipelines → Add repository** and pick it from the list. You can leave the webhook secret empty. If the App is installed on the repository's owner but doesn't include that repository, its setup steps link to the installation on GitHub, where you can add it.

Runs report commit statuses through the App. A status token you set on the repository is used instead of the App, if one is set.

Trusted jobs can call the GitHub API with `secrets.GITHUB_TOKEN`, as in GitHub Actions:

```yaml
- run: gh pr comment "$PR" --body "Deployed to ${{ steps.deploy.outputs.url }}"
  env:
    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

The token covers only the run's repository, lasts at most an hour, and is masked in logs. Pull requests from forks and other untrusted runs never get it. A repository secret named `GITHUB_TOKEN` replaces it.

## Runners

In **New → GitHub Actions runner**, set **Authenticate with** to **Skiff's GitHub App**. The pool uses the installation on the runner's owner, so nothing is stored in the project. The installation needs *Administration: write* for repository runners, or *Self-hosted runners: write* for organisation runners.

## Disconnect or remove

- **Disconnect** an installation from its menu in **Settings → GitHub**. Builds and pipelines for its repositories fall back to hand-made webhooks and node credentials. The App stays installed on GitHub until you uninstall it there.
- **Remove App** forgets the App and every installation, for every organisation. Delete the App on GitHub as well if you no longer need it.

Uninstalling the App on GitHub tells Skiff through the webhook, and the installation disappears from Settings.
