---
title: GitLab, Gitea and Forgejo
description: Connect GitLab, Gitea or Forgejo with a token for repository pickers, webhooks Yoal creates, private clones, commit statuses and Deploy from Git.
---

Everything the [GitHub App](/deploying/github) does for GitHub, a **git provider connection** does for GitLab, Gitea and Forgejo. These forges have no App to install, so you give Yoal an API token instead, and Yoal uses it to set things up for you. gitlab.com, Codeberg and self-hosted instances all work.

You don't need a connection. Without one, git builds and pipelines work with hand-made webhooks and node credentials, as described in [Git builds](/deploying/git-builds) and [Pipelines](/deploying/pipelines). Those hand-made webhooks accept GitLab, Gitea and Forgejo deliveries too.

## What a connection does

| Area | GitLab | Gitea and Forgejo |
| --- | --- | --- |
| Pickers | Projects you can push to appear in the git source, pipeline repository and registry trust forms, and in **Deploy from Git**. | Repositories the token can see appear in the same places. |
| Events | Yoal creates a project webhook (push and merge request events) for each repository a git source or pipeline uses. | Yoal creates a repository webhook (push and pull request events). |
| Whole groups | **Watch a group** creates one group webhook. It needs GitLab Premium, or a self-managed instance that has group webhooks. | **Watch an organisation** creates one organisation webhook. |
| Private clones | Build nodes get a read-only **deploy token** for that one project, which expires after two days. Yoal creates it, so the API token needs the *Maintainer* role. Otherwise the clone token is used. | Build nodes get the connection's optional **clone token**, sent only to that host. |
| Commit statuses | Builds report `yoal-build/<project>` and pipeline runs report `yoal/<workflow>`, shown as *running*, *passed*, *failed* or *canceled*. | The same statuses, under the same names. |
| Deployments | A promoted build is recorded as a deployment to environment `<project>`. A preview build goes to `<project>-preview`. | Gitea and Forgejo have no deployments API. |
| Pipelines on push | A push through a group webhook adds a repository that has `.yoal/workflows` to Pipelines. | The same, through an organisation webhook. |
| Merge and pull requests | A merge request from a fork runs **untrusted**: it gets no secrets, no environments and no deploys. | A pull request from a fork runs untrusted. |

## Connect a forge

An organisation owner or admin does this.

1. Create a token on the forge:
   - **GitLab**: a group access token (role *Maintainer*, scope `api`) is best, because it can create deploy tokens and webhooks for every project in the group. A personal access token with `api` also works.
   - **Gitea or Forgejo**: an access token with `write:repository` and `read:user`. Add `write:organization` if you want to watch an organisation.
2. Optionally, create a second, read-only token for clones: `read_repository` on GitLab, `read:repository` on Gitea or Forgejo. Build nodes may receive this token, so use a bot account that can read only the repositories Yoal builds.
3. In Yoal, open **Settings → Git providers** and choose **Connect**. Pick the forge, enter the instance URL (gitlab.com and Codeberg are filled in for you), and paste the token or tokens.

As soon as you connect, Yoal creates webhooks for the repositories your projects and pipelines already use on that forge, so nothing needs re-saving.

Yoal checks each token with the forge before saving it. Tokens are sealed with your organisation's key and never shown again. The API token never leaves the control plane.

An instance on a private network (a homelab address such as `192.168.0.9`, or a `.lan` or `.local` name) can only be connected by a platform admin. This stops the control plane from being used to reach machines on its own network.

## Use it

- **Deploy from Git.** **Projects → Deploy from Git** lists repositories from every connected provider. Pick one, and Yoal reads it, picks a framework preset, creates the project and its git source, makes the webhook, and queues the first build.
- **Git sources and pipelines.** Choose a repository in the picker, or paste its clone URL. When a connection serves that URL, Yoal creates the webhook as soon as you save, so you don't need a webhook secret.
- **Pipelines on push.** Watch a group or organisation, and a push that adds `.yoal/workflows` to one of its repositories adds that repository to Pipelines. The **Set up pipelines automatically** switch on **Settings → Git providers** is the same setting as on Settings → GitHub, and it lists removed repositories you can allow again.
- **Retry or add webhooks.** Each connection on **Settings → Git providers** lists the webhooks Yoal created and any error the forge returned, with a **Retry** button. **Add a repository webhook** re-creates one by hand.

When Yoal's webhook already delivers a repository, a hand-made webhook for the same repository is accepted and ignored, so one push never starts two builds.

## Hand-made webhooks

If a repository's forge isn't connected, add a webhook yourself with the project's or pipeline repository's webhook URL and a secret of at least 16 characters:

- **GitLab**: project settings → **Webhooks**. Paste the secret as the **Secret token** and tick **Push events** (and **Merge request events** for pipelines).
- **Gitea or Forgejo**: repository settings → **Webhooks** → **Add webhook** → Gitea or Forgejo. Use content type JSON, paste the secret, and select push (and pull request) events.

A project's webhook is also served at `/api/webhooks/git/<project>`.

## GitLab CI to the registry

GitLab CI jobs can push to the [container registry](/compute/apps-and-containers) without a stored secret. Add a trust under **Registry → CI identities**: choose **GitLab CI**, enter the GitLab instance (leave it blank for gitlab.com), the project path, and the registry repository. Then, in `.gitlab-ci.yml`:

```yaml
push-image:
  id_tokens:
    YOAL_ID_TOKEN:
      aud: registry.example.com
  script:
    - echo "$YOAL_ID_TOKEN" | docker login registry.example.com -u gitlab-oidc --password-stdin
    - docker push registry.example.com/acme/app:$CI_COMMIT_SHORT_SHA
```

Yoal checks the token's signature against the instance's published keys, then its audience, project path and ref (`refs/heads/<branch>` or `refs/tags/<tag>`).

## Sign in

GitLab, Gitea and Forgejo are OpenID Connect providers, so an organisation can require sign-in through any of them under **Settings → Single sign-on**. Presets fill in the issuer for you.

A platform-wide **Continue with GitLab** button appears on the sign-in page when the control plane has `GITLAB_CLIENT_ID` and `GITLAB_CLIENT_SECRET`. For a self-managed instance, also set `GITLAB_ISSUER`. The application's redirect URI is `https://<your control plane>/api/auth/callback/gitlab`, with the `read_user` scope.

## What isn't there yet

- **Runner pools for GitLab Runner or Forgejo/Gitea runners.** Only the GitHub Actions runner template exists today.
- **A `GITHUB_TOKEN`-style secret in pipelines.** None of these forges can mint a short-lived token for one repository, so add the token you need as a pipeline secret.
- **Gitea and Forgejo Actions ID tokens for the registry.** Use an API key until their ID-token support settles.
- **Merge request comments and per-request preview deployments.**

## Over the API

| Endpoint | What it does |
| --- | --- |
| `GET`, `POST /api/v1/git/connections` | List or create connections. |
| `GET`, `PATCH`, `DELETE /api/v1/git/connections/<id>` | Read a connection, rename it, replace its tokens, or remove it. |
| `POST /api/v1/git/connections/<id>/webhooks` | Create a webhook: `{ "repository": "group/app" }` or `{ "namespace": "group" }`. |
| `GET /api/v1/git/repositories` | Repositories from every provider. |
| `GET /api/v1/git/detect`, `POST /api/v1/git/import` | Deploy from Git. Add `connectionId` for a forge repository. |

Agents can use the MCP tools `list_git_repositories` and `deploy_from_git`.
