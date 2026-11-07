---
title: Quickstart
description: From a fresh Debian or Ubuntu server to a live site: install Skiff, create the owner account, deploy with the skif CLI, then roll back.
---

This page takes you from an empty server to a deployed site, with a rollback you have tried. It covers one VPS, one domain and the `skif` CLI. Each step is short and links to the page that covers it in full. If you want the background first, read [Concepts](/getting-started/concepts).

## 1. Check the prerequisites

You need:

- A **Debian or Ubuntu** server (x86_64 or arm64) that you can reach as root or with `sudo`.
- A **domain** you control, with DNS you can edit. Point an `A` record for the dashboard (for example `control.example.com`) and one for the sites domain (for example `sites.example.com`, which serves sites on its subdomains) at the server's IP address. The installer checks these records and, when run interactively, lets you re-check while they propagate.
- **Caddy**, which serves the dashboard and your sites. The installer installs Caddy and Podman for you if they are missing. If you already run them, pass `--skip-deps` in step 2.

You do not need Node, Docker or a database on the server. Skiff brings its own Bun runtime.

> [!NOTE]
> You can also install without a domain. Leave the domain options blank and the dashboard is served on the server's IP address over plain HTTP. Passkeys then need HTTPS, so you will sign in with a password and an authenticator app. See [Installation](/self-hosting/installation) for the trade-offs.

## 2. Run the installer

The bootstrap script installs Bun and the Skiff source, then runs the installer. It asks you a few questions when run from a terminal. To see the plan without changing anything, add `--dry-run`:

```sh
curl -fsSL https://raw.githubusercontent.com/KieranHolroyd/skiff/main/install.sh | sudo sh -s -- --dry-run
```

When the plan looks right, run it for real with your domains:

```sh
curl -fsSL https://raw.githubusercontent.com/KieranHolroyd/skiff/main/install.sh | sudo sh -s -- \
  --platform-host control.example.com \
  --content-domain sites.example.com \
  --acme-email you@example.com \
  --admin-email you@example.com
```

`--acme-email` turns on HTTPS. `--admin-email` pre-fills the owner's email in the setup wizard. The installer builds the release, starts the services, checks that the platform answers, and then prints a one-time setup link. Leave the terminal open until it prints that link.

To see every option, run the installer with `--help`. The full list, host layout and upgrade steps are on the [installation](/self-hosting/installation) page.

## 3. Create the owner account

Open the setup link the installer printed. It has the form `https://control.example.com/setup?token=…`. The wizard only runs while no account exists. Once the owner is created, the link sends you to sign-in instead.

If the link is lost, read the token on the server:

```sh
sudo cat /etc/skiff/setup-token
```

Or find the link in the control plane's logs:

```sh
journalctl -u skiff-control-plane | grep setup
```

The wizard runs through these steps:

1. **Check.** It shows what this install looks like: HTTPS, passkey support in your browser, email, storage and nodes.
2. **Account.** Enter your name, email, an organisation name and a password of at least 12 characters.
3. **Secure.** Owners must have a second factor. Add a **passkey**, or set up an **authenticator app** if passkeys are not available. The app setup gives you backup codes, so keep them somewhere safe.

After this you are signed in as the owner of the organisation. The rules for second factors, and how to sign in again later, are on [Sign-in and 2FA](/accounts/sign-in-and-2fa).

## 4. Install the CLI and sign in

The `skif` CLI deploys sites from your terminal. It needs Node.js 20 or later, or Bun.

```sh
npm install -g @skiffy/skiff
```

Sign in to your platform. This opens your browser so you can approve the CLI:

```sh
skif login --url https://control.example.com
```

If you are on a machine without a browser, add `--no-browser` to print the approval URL instead. The CLI saves a new API key to `~/.config/skiff/config.json` with mode `0600`. `skif logout` removes the key and keeps the URL.

The binary is also installed as `skiff`, so either name works. See the [CLI reference](/clients/cli) for every command.

## 5. Deploy a folder

Build your site so it lives in a folder, for example `dist/`. Then deploy the folder:

```sh
skif deploy ./dist --project my-site
```

The CLI zips the folder, uploads it and promotes it to production. The project is created if it does not exist, and the project name comes from `--project`, or from the folder name if you leave it out. The output lists the project, the deployment ID, and a **Preview** and a **Production** URL.

New projects are public in production, and their previews need a Skiff sign-in. Change that from the dashboard, or see [Access and sharing](/deploying/access-and-sharing). For more on folders, single-page apps and redirects, see [Static sites](/deploying/static-sites).

Check the site with:

```sh
skif status my-site
skif open my-site
```

## 6. Promote a deployment and roll back

Each deploy is a new deployment. To try a change without touching production, deploy it as a preview:

```sh
skif deploy ./dist --project my-site --no-promote
```

Open the preview URL, then list the deployments to find the new ID:

```sh
skif deployments my-site
```

The production deployment is marked with `*`. Promote the one you tested:

```sh
skif promote my-site <deploymentId>
```

If something is wrong after a promote, move production back one deployment:

```sh
skif rollback my-site
```

Promote and rollback only move the production pointer, so both finish almost at once. The commands are covered in the [CLI reference](/clients/cli), and the wider release model is in [Domains and environments](/deploying/domains-and-environments).

## 7. Optional: connect an AI agent

Skiff has an MCP server, so an AI agent can deploy and inspect sites with the same permissions you have. In Claude Code, add it like this:

```sh
claude mcp add --transport http skiff https://control.example.com/mcp
```

The client finds the sign-in server itself. You then approve it on a consent screen, and choose which permissions it gets. Destructive actions ask you to confirm. The tool list and the rules for tokens are on [MCP](/clients/mcp).
