# Self-hosted updaters and the release pipeline: how comparable products ship, verify, gate and recover updates

Research date: 2026-11-05. Some sources are community threads or older material; flagged where relevant. The ONCE and Coolify findings come partly from reading their source on GitHub (default branch, Nov 2026), not just their docs.

## 1. How do comparable products update themselves, and how does each roll back?

### Takeaway
The products with real automatic rollback all work the same way. They stage a complete, prebuilt, immutable unit (an A/B rootfs slot, a boot environment, a new container next to the old one, or a side-by-side versioned directory). They health-check it, and only then retire the old one. Products that tear down the old version before the new one is proven (Coolify's upgrade.sh, Discourse's `launcher rebuild`) have no automatic rollback. The usual recovery for them is "restore a backup". In almost every product, rolling back data or schema is explicitly unsupported. Only the code or image rolls back.

### Cited Findings

**37signals ONCE (Campfire/Writebook; Go CLI + Docker + kamal-proxy, SQLite on a volume)**
- `Application.Update()` pulls the image and compares the pulled image ID with the running container's image ID. If they differ, it calls `deployWithVolume`. The result of every update attempt is recorded via `s.RecordUpdate(name, err)`. — [basecamp/once internal/docker/application.go](https://github.com/basecamp/once/blob/main/internal/docker/application.go)
- `deployWithVolume` creates a *new* container with a random-suffixed name (`<ns>-app-<name>-<id>`) that mounts the *same* data volume and has `RestartPolicyAlways`. It then runs `kamal-proxy deploy <app> --target <container> --deploy-timeout 120s`. If kamal-proxy reports `target not healthy` or `deploy timed out`, the new container is force-removed, the old one keeps serving, and the result is `ErrAppNotStarted`. Old containers are removed only after the proxy switch succeeds (`removeContainersExcept`). — [application.go](https://github.com/basecamp/once/blob/main/internal/docker/application.go), [proxy.go](https://github.com/basecamp/once/blob/main/internal/docker/proxy.go)
- Apps must expose a health endpoint: "Has a healthcheck endpoint at `/up` that returns success." The README says ONCE "provides automatic updates, backups, and system information". Updates are a per-app "Automatically apply updates" checkbox plus a manual "Check for updates" button. — [basecamp/once README](https://github.com/basecamp/once), [settings_form_updates.go](https://github.com/basecamp/once/blob/main/internal/ui/settings_form_updates.go)
- The ONCE binary updates itself separately from the apps. `once self-update` queries `api.github.com/repos/basecamp/once/releases/latest`, picks the asset `once-<GOOS>-<GOARCH>`, downloads it to `.once-update-tmp` beside the executable, and replaces the binary. — [internal/version/updater.go](https://github.com/basecamp/once/blob/main/internal/version/updater.go)
- SQLite consistency for backups comes from a `pre-backup` hook that can use "SQLite's online backup feature". Without the hook, ONCE "will pause the application's container while it copies the file". — [basecamp/once README](https://github.com/basecamp/once)

**Kamal**
- `kamal rollback <version>` stops the current container and starts one from an older image still on the host. "Nothing needs to be downloaded from the registry." "By default, old containers are pruned after 3 days when you run `kamal deploy`." — [kamal-deploy.org rollback](https://kamal-deploy.org/docs/commands/rollback/)
- Traffic moves only after kamal-proxy's health check passes. ONCE's use of `kamal-proxy deploy ... --deploy-timeout` and its handling of the `target not healthy` error show this. — [once proxy.go](https://github.com/basecamp/once/blob/main/internal/docker/proxy.go)

**Coolify (Laravel control plane in Docker Compose)**
- Version discovery comes from `https://cdn.coollabs.io/coolify/versions.json`. Auto-update is on by default and runs on a cron (defaults: check hourly `0 * * * *`, update daily `0 0 * * *`). — [coolify.io upgrade docs](https://coolify.io/docs/get-started/upgrade), [Update Coolify](https://coolify.io/docs/core/instance-management/update)
- "If a database backup is configured, Coolify runs it before updates. If the database backup fails, the update does not start." — [coolify.io upgrade docs](https://coolify.io/docs/get-started/upgrade)
- `upgrade.sh` does the following: curls `docker-compose.yml`, `docker-compose.prod.yml`, `.env.production` and `upgrade-postgres.sh` from the CDN with no checksum or signature verification; backs up only `.env`; pulls images with five retries and jitter; then, in a detached `nohup` process, **stops and removes `coolify`, `coolify-db`, `coolify-redis` and `coolify-realtime` before starting the new stack** with `docker compose up -d --wait --wait-timeout 60`. If `--wait` fails, the script still counts the upgrade as a success when the `coolify` container is running. There is no HTTP health check and no rollback. — [coollabsio/coolify scripts/upgrade.sh](https://raw.githubusercontent.com/coollabsio/coolify/main/scripts/upgrade.sh)
- Downgrade means rerunning `upgrade.sh <older-version>` from the terminal. Auto-update must be disabled first, or it will re-upgrade. "It does not roll back your applications, databases, services, managed servers, or their data." "An older Coolify release may not work with database changes made by a newer release". If it breaks, restore the backup. — [Coolify downgrade docs](https://coolify.io/docs/core/instance-management/downgrade)
- Running `upgrade.sh` without a version writes `COOLIFY_VERSION=latest` to `.env`, which "breaks update checks". `install.sh` on an existing instance "resets ownership and permissions under /data/coolify". — [coolify.io upgrade docs](https://coolify.io/docs/get-started/upgrade)

**Discourse (`launcher rebuild` builds the image on the host)**
- A rebuild "bootstraps" a base image (`discourse/base` on Docker Hub) on the host. Gems, pnpm, the Ember build and plugins are all built locally. — [Meta: ship images that don't need bootstrapping](https://meta.discourse.org/t/can-discourse-ship-frequent-docker-images-that-do-not-need-to-be-bootstrapped/33205/1)
- Rolling back versions "isn't supported". "If the database has been upgraded and you didn't take a backup then you can't." A rebuild that fails before migration can leave no runnable container because the old container is gone. The recovery suggested on the forum is to pin `version:` in app.yml and restore from backup. — [Meta: Rollback upgrades](https://meta.discourse.org/t/rollback-upgrades/116074) (community thread)
- In July 2025 `discourse_docker` changed the launcher to download, checksum and use a separate `github.com/discourse/launcher`. — [discourse_docker mirror](https://gitea.cncfstack.com/discourse/discourse_docker/src/branch/update-launcher) (mirror, not the canonical repo)

**GitLab Omnibus**
- Required upgrade stops: "In GitLab 17.5 and later, to provide a predictable upgrade schedule," stops fall at `x.2.z`, `x.5.z`, `x.8.z`, `x.11.z` (18.2/18.5/18.8/18.11, and 19.x likewise). You must go to the *latest patch* of each stop and let background migrations finish before continuing. There is an Upgrade Path tool. — [docs.gitlab.com upgrade paths](https://docs.gitlab.com/update/upgrade_paths/)

**Home Assistant OS + Supervisor**
- HAOS uses RAUC image-based updates. "An update does not change files on a running system." The Supervisor downloads a signed `.raucb` bundle and asks RAUC over D-Bus to install it into the inactive slot. It then sets `version_pending` and "does not reboot by itself". After the reboot, "Once the Supervisor has started, it marks the booted slot as good"; "If it never gets marked as good, the bootloader falls back to the other slot." GRUB allows 3 attempts (state in `EFI/BOOT/grubenv`). U-Boot keeps the state on a `hassos-bootstate` partition. Pi 5 uses firmware tryboot. — [HA contributors: OS update system](https://contributors.home-assistant.io/os/operating-system/update-system/)
- The bundle `compatible` value is `haos-<board id>`, so a bundle installs only on matching hardware. — [same](https://contributors.home-assistant.io/os/operating-system/update-system/)
- The "Create a full backup" action can be automated to run when the Core update entity turns on (HAOS only). The community reports that since core-2025.1 the automatic backup on add-on update was removed. Add-on rollback means a partial restore from backup. — [hassio.backup_full](https://www.home-assistant.io/actions/hassio.backup_full/), [community thread](https://community.home-assistant.io/t/how-do-i-roll-back-an-addon-to-a-previous-version/821881) (community-reported, not confirmed in a changelog)
- Supervisor release pipeline: merge to main → dev build → release → beta build → `stable.json` updated → beta promoted to stable. Users pick a channel with `ha supervisor options --channel`. — [home-assistant/supervisor README](https://github.com/home-assistant/supervisor), [HA OS common tasks](https://www.home-assistant.io/common-tasks/os)

**TrueNAS (ZFS boot environments)**
- Before an update, TrueNAS snapshots the current boot environment and adds it to the boot menu. Rollback means Activate (UI), picking the entry at the boot menu, or `beadm activate <name>`, then reboot. Changes made in an older environment don't carry forward. Docs recommend keeping current plus 1–2 previous releases and marking one "Keep". — [TrueNAS CORE 13.3 boot environments](https://www.truenas.com/docs/core/13.3/coretutorials/systemconfiguration/managingbootenvironments/), [SCALE 25.10](https://www.truenas.com/docs/scale/25.10/scaletutorials/systemsettings/managebootenvironscale/), [SCALE 27 (dev docs)](https://www.truenas.com/docs/scale/27/systemsettings/boot/managebootenviron/)

**Umbrel**
- OTA updates "are never installed automatically". There is a "safe update system": on failure the device "automatically rolls back to the previous version" and "You won't lose any data or settings." — [umbrel.com support](https://umbrel.com/support/basics/updating-umbrelos)
- Forum reports include updates that fail and boot back (e.g. "says update failed and boots back to 1.2.2") and also nodes that never come back after an update (1.3→1.7 era, Mender-based updater). — [Umbrel community: Update 1.3 to 1.4 failed](https://community.umbrel.com/t/update-1-3-to-1-4-failed/21839), [Updated OS, now node dead](https://community.umbrel.com/t/updated-os-now-node-dead/25434) (anecdotal)

**Sentry self-hosted**
- Hard stops: 9.1.2, 21.5.0, 21.6.3, 23.6.2, 23.11.0, 24.8.0, 25.5.1. Avoid 23.7.0 because of migration and Django 3 issues. "If you upgrade infrequently, it's less likely that upgrading to the latest version will work." — [Sentry self-hosted releases (mirror of develop.sentry.dev)](https://backiee.wasmer.app/https_develop_sentry_dev/self-hosted/releases) (mirror; verify on develop.sentry.dev)

**Plausible CE**
- Upgrading means bumping the image tag in compose and running `docker compose up -d`. The docs say to `pg_dump` first and run migrations via `Plausible.Release.migrate()`. Direct v2.1.1→3.0.1 upgrades crashed for some users. — [Plausible releases](https://www.github.com/plausible/analytics/releases), [Mintlify mirror of upgrade doc](https://www.mintlify.com/plausible/analytics/self-hosting/upgrade) (mirror; possibly stale), [discussion #5625 (mirror)](https://backiee.wasmer.app/https_git_codeproxy_net/plausible/analytics/discussions/5625)

**CapRover**
- App-level "one click rollback" picks an earlier image from deploy history. It does not restore env vars, domains, volume contents or DB schema. — [caprover.com deployment methods](https://caprover.com/docs/deployment-methods), [v1.0.0 release](https://github.com/caprover/caprover/releases/tag/v1.0.0)

**Caddy (single binary)**
- `caddy upgrade` (experimental) replaces the binary with the latest from the download page, keeping the same modules. "The current binary is backed up first (copied beside the current one)" and restored automatically on failure. `-k/--keep-backup` keeps it afterwards. It "only replaces the binary on disk" and does not interrupt running servers. — [caddyserver.com command line](https://caddyserver.com/docs/command-line)

**Tailscale (single binary)** — see section 3 for signing.

### Inferences
- Skiff's design (canary boot against a copy of the DB, then a symlink swap, keeping `previous`) is already closer to the ONCE/Kamal/HAOS pattern than to Coolify or Discourse. The weak point is the *build* phase on the host, not the swap.
- ONCE is the closest analogue: one product, SQLite on a shared volume, new container started beside the old, a `/up` health gate with a 120 s timeout, old removed only after the switch. It does **not** snapshot the SQLite DB before the new container runs migrations, as far as the code read shows. A bad migration is therefore not rolled back. Skiff's "canary against a DB copy" goes beyond ONCE here.
- The HAOS "mark good only after the Supervisor has started" design means the *new* code must positively confirm health, and silence means rollback. That is the inverse of "rollback only if a check explicitly fails", and it is more robust to hangs and crashes in the verifier itself.

### Gaps
- Dokku's self-upgrade (apt package plus `dokku-update`) and its rollback: no source retrieved this session.
- Mattermost and Grafana: no source retrieved on self-update. My understanding is that both rely on the OS package manager or a new Docker image with no built-in updater, but this is unverified.
- GitLab Omnibus's automatic pre-upgrade DB backup (the `/etc/gitlab/skip-auto-backup` behaviour) and its handling of a failed `reconfigure`: not verified this session.
- Umbrel's mechanism (A/B? Mender?) is not documented in the official page. One forum post mentions Mender.
- I found no official Discourse 2025/2026 announcement of prebuilt, no-bootstrap images.

## 2. Building on the host vs prebuilt artifacts (failure modes; Bun `--compile`)

### Takeaway
Building on the host is a documented and recurring failure source. The causes are RAM (Ember/Vite builds), registry and network rate limits, and toolchain or Docker-version drift. Mature products ship prebuilt artifacts (OCI images, signed OS bundles, single binaries) so the host only downloads, verifies and swaps. For a SvelteKit-on-Bun app, the official `@sveltejs/adapter-bun` can now emit a single executable (`compile: true`) that embeds server code, client assets and the Bun runtime. That removes `bun install` and `vite build` from the host entirely.

### Cited Findings
- **Memory:** Discourse, April 2025. A 2 GB instance failed to bootstrap because the Ember build used up RAM plus swap and needed about 2.5 GB of swap at peak. The team confirmed 2 GB "is enough for docker rebuilds, but not for the web upgrader to work", because "the build tooling is designed for machines with much more memory". An 8 GB host got SIGKILL in `ember build -prod` (ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL) until the web container was stopped first. — [Meta: High rebuild memory requirements, April 2025](https://meta.discourse.org/t/high-rebuild-memory-requirements-april-2025-edition/360419), [Meta: ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL](https://meta.discourse.org/t/rebuild-fails-with-exit-1-err-pnpm-recursive-exec-first-fail/351862?tl=en), [Meta: Cannot allocate memory (older)](https://meta.discourse.org/t/cannot-allocate-memory-when-upgrading/44029?tl=en)
- **Registry rate limits:** Coolify v329 scheduled backups failed because the `coolify-helper` image could not be pulled from ghcr.io due to rate limiting. — [coolify#3355](https://github.com/coollabsio/coolify/issues/3355)
- **Dependency health at upgrade time:** Coolify upgrade from beta.398: `coolify-redis` failed its health check, so the main container was never created. Both upgrade and downgrade then gave a 404. — [coolify#5288](https://github.lhy31512.workers.dev/coollabsio/coolify/issues/5288) (mirror of GitHub issue)
- **Host toolchain drift:** Coolify's upgrade.sh has to detect a Docker Engine 27.0–28.0.0 network-gateway bug and abort. A Docker 25 upgrade broke HA Supervisor container networking until Docker was downgraded. Supervisor images newer than 12.0 failed with `exec format error` on a mis-detected architecture. — [coolify upgrade.sh](https://raw.githubusercontent.com/coollabsio/coolify/main/scripts/upgrade.sh), [supervisor#4827](https://github.com/home-assistant/supervisor/issues/4827), [HA community](https://community.home-assistant.io/t/hassio-supervisor-crashes-on-every-version-after-2024-12-0/823439)
- **Stalled upgrades:** Coolify beta.418→432. The UI upgrade never completes, and the manual script quits early. — [coolify#6732](https://github.com/coollabsio/coolify/issues/6732)
- **Prebuilt artifact formats in use:** HAOS ships signed RAUC bundles of prebuilt partition images. ONCE apps and Coolify ship OCI images. ONCE itself and Tailscale ship per-OS/arch single binaries (`once-<GOOS>-<GOARCH>`). Caddy ships a single binary from its download page. — [HA update system](https://contributors.home-assistant.io/os/operating-system/update-system/), [once updater.go](https://github.com/basecamp/once/blob/main/internal/version/updater.go), [caddy command line](https://caddyserver.com/docs/command-line)
- **SvelteKit + Bun single executable:** with `@sveltejs/adapter-bun`, `compile: true` builds `<out>/server`, which "embeds the server code, client assets, prerendered output, and Bun runtime". Production deps are bundled because "there is no node_modules" at runtime. Packages that read files relative to their own location (e.g. `jsdom`) must be marked `external` with `compile: { autoloadPackageJson: true }`. Cross-compiling works via e.g. `compile: 'linux-x64'` or `{ target: 'bun-linux-x64', outfile }`. `precompress` is ignored with compile. Sourcemaps default to external. "Bun 1.4 or newer is required." "Platform targets, native dependencies, and other limitations follow" Bun's executable rules. — [svelte.dev adapter-bun](https://svelte.dev/docs/kit/adapter-bun)
- **Native addons:** compiled `.node` addons cannot be embedded in the binary. The OS must load them as separate shared libraries, so the workaround is shipping the `.node` file beside the executable and resolving it via `process.execPath`. — [imgkit Bun executable guide](https://nexus-aissam.github.io/imgkit/guide/bun-executable) (third party). A native module that Bun cannot resolve fails the compile. — [sveltekit-exec-adapter docs](https://zarqi.is-a.dev/sveltekit-exec-adapter/docs/build-process) (third party)
- Bun's compiler supports cross-compilation, file embedding and bytecode caching, and "runs the same code as `bun run`". — [bun.com/docs/compiler](https://bun.com/docs/compiler)

### Inferences
- Skiff's 3.2 GB peak build on the production host matches the Discourse failure pattern almost exactly. Discourse's own team says the in-app (web) upgrader is less reliable than a CLI rebuild for this reason. Moving `bun install` and `vite build` into CI removes the memory, network/registry, lockfile and toolchain-drift classes in one step.
- `bun:sqlite` is built into the Bun runtime rather than being an npm native addon (inference from Bun's design, not verified in a fetched doc this session). A Skiff that uses only `bun:sqlite` and pure-JS deps is therefore a good candidate for `adapter-bun` `compile: true`. Any `.node` dependency (e.g. sharp, better-sqlite3) would need shipping beside the binary or replacing.
- The artifact choice for Skiff is (a) a single Bun executable per OS/arch, (b) a tarball of `build/` plus `node_modules` produced by CI, paired with a pinned Bun version, or (c) an OCI image. (a) and (c) make "what runs" a single content-addressed thing that is easy to hash, sign and keep as `previous`.

### Gaps
- Bun's own executables page (`bun.com/docs/bundler/executables`) returned 404, so I could not retrieve Bun's official caveat list (binary size, macOS codesigning, baseline vs modern x64 CPU targets, Windows). The canonical URL may have moved.
- No quantified data on how often on-host builds fail across a fleet.

## 3. Update integrity: TUF, Sigstore/cosign, minisign/signify, GitHub attestations

### Takeaway
Tailscale's distsign is the most relevant production model for a small self-hosted product. It uses offline Ed25519 root keys compiled into the client, which sign rotatable online signing keys, which sign each artifact; the client verifies before installing. TUF adds protection against rollback and freeze attacks through versioned, expiring metadata and threshold keys. Sigstore and GitHub attestations bind an artifact to the CI workflow that built it. Several self-hosted updaters (Coolify's upgrade.sh, ONCE's self-update) verify nothing beyond TLS.

### Cited Findings
- **Tailscale distsign** (since PR #8943, 2023). "Offline root keys sign signing keys, and signing keys sign the distributed files." All keys are Ed25519. Signing keys are fetched before each download so they can rotate. Root keys change only through a new client release, and several root keys allow rotation without reusing a retired one. The client checks each file's `.sig`. If verification fails against every root, the error suggests an attack *or a very old client with outdated root keys*. — [tailscale PR #8943](https://github.com/tailscale/tailscale/pull/8943), [pkg.go.dev distsign v1.84.2](https://pkg.go.dev/tailscale.com@v1.84.2/clientupdate/distsign), [distsign.go v1.66.3](https://github.com/tailscale/tailscale/blob/v1.66.3/clientupdate/distsign/distsign.go)
- **HAOS / RAUC:** "RAUC checks the signature against the keyring in `/etc/rauc/keyring.pem` before it installs anything." Production images trust only the release CA and reject self-signed bundles. A keyring change made at runtime does not survive a reboot (the rootfs is read-only). — [HA update system](https://contributors.home-assistant.io/os/operating-system/update-system/)
- **TUF:** it prevents rollback ("cannot trick clients into installing software that is older than that which the client previously knew to be available") via versioned metadata. It prevents freeze attacks via expiration: a client aborts and reports a potential freeze if trusted metadata has expired. Roles support multiple keys with threshold/quorum signing, so one stolen key cannot push a malicious update. The timestamp role is the short-lived freshness anchor. — [theupdateframework.io security](https://theupdateframework.io/security/), [TUF specification](https://theupdateframework.io/specification)
- **GitHub artifact attestations:** generate with `actions/attest@v4` (permissions `id-token: write`, `contents: read`, `attestations: write`, plus `packages: write` for images). Verify with `gh attestation verify <file> -R ORG/REPO`, or `oci://` for images. An offline verification guide exists. — [docs.github.com artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)
- **cosign keyless:** verification must pin the signer with `--certificate-identity` (the workflow URL, e.g. `https://github.com/ORG/REPO/.github/workflows/release.yml@refs/tags/vX`) and `--certificate-oidc-issuer https://token.actions.githubusercontent.com`. A loose `--certificate-identity-regexp` weakens the check. — [Chainguard: verify file signatures with cosign](https://edu.chainguard.dev/open-source/sigstore/cosign/how-to-verify-file-signatures-with-cosign/)
- **ONCE self-update:** in the code read, it resolves the latest GitHub release, downloads the arch asset with an `Accept: application/octet-stream` request, and replaces the binary. No checksum or signature step was visible in `UpdateBinary`/`downloadBinary`. — [once updater.go](https://github.com/basecamp/once/blob/main/internal/version/updater.go) (I did not read `replaceBinary` in full)
- **Coolify upgrade.sh:** "does not verify checksums or signatures" for the compose and env files it fetches from the CDN. — [upgrade.sh](https://raw.githubusercontent.com/coollabsio/coolify/main/scripts/upgrade.sh)
- **Discourse launcher:** since July 2025 the launcher binary is downloaded *and checksummed*. — [discourse_docker mirror](https://gitea.cncfstack.com/discourse/discourse_docker/src/branch/update-launcher)

### Inferences
- A good fit for Skiff is a distsign-style minimal scheme: an Ed25519 root key held offline, a CI-held signing key, and a signed `manifest.json` (version, channel, sha256 per artifact, monotonically increasing serial, expiry). That gives Tailscale's verification plus TUF's anti-rollback (reject a serial below the last seen) and anti-freeze (reject expired manifests) without running a full TUF repository. minisign/signify are a lighter alternative to raw Ed25519. GitHub attestations or cosign can be layered on for provenance, but they add a dependency on Sigstore and GitHub availability at verify time unless bundles are verified offline.
- Signing the *manifest* (not only the artifact) is what lets the release side pull or block a version (section 4).

### Gaps
- No retrieval of minisign/signify docs, go-tuf, or reproducible-builds material this session. Their exact verification APIs are not documented here.
- The plan and visibility limits for GitHub attestations on private repos were not covered on the page fetched.

## 4. Release-side gating: upgrade tests, channels, staged rollout, kill switches

### Takeaway
The products that ship to many unattended hosts gate releases through channels (dev → beta → stable promotion) and serve a version manifest they control (HA `stable.json`, Coolify `versions.json`). Moving that pointer is the kill switch. CrowdStrike's 2024 outage is the canonical example of what happens without staged rollout and with a validator that lets a malformed artifact through. Upgrade stops (GitLab, Sentry) show that "upgrade from N-k" is a real compatibility surface that must be tested or constrained.

### Cited Findings
- **HA Supervisor promotion pipeline:** dev → beta → update `stable.json` → beta promoted to stable. Channels are stable/beta/dev, and dev is flagged as likely unstable. — [home-assistant/supervisor](https://github.com/home-assistant/supervisor), [Supervisor 0.99 release](https://github.com/home-assistant/supervisor/releases/tag/0.99), [HA OS common tasks](https://www.home-assistant.io/common-tasks/os)
- **The channel contained the blast radius:** in Nov 2022 the broken Supervisor 2022.11.0 hit only beta/dev users. "Users on stable releases were not affected." — [HA community, 16 Nov 2022](https://community.home-assistant.io/t/supervisor-november-beta-issue-impacting-users-on-home-assistant-beta-dev-channels/489895)
- **Central version manifest:** Coolify instances learn what to install from `cdn.coollabs.io/coolify/versions.json`. — [coolify.io upgrade docs](https://coolify.io/docs/get-started/upgrade)
- **Upgrade-path constraints:** GitLab requires stops at x.2/x.5/x.8/x.11 and the latest patch of each, with background migrations completed between stops. Sentry has hard stops (…24.8.0, 25.5.1) and warns infrequent upgraders that jumping to latest is less likely to work. — [GitLab upgrade paths](https://docs.gitlab.com/update/upgrade_paths/), [Sentry releases (mirror)](https://backiee.wasmer.app/https_develop_sentry_dev/self-hosted/releases)
- **CrowdStrike Channel File 291 (19 Jul 2024):** the new Template Type expected 21 input fields but the integration code supplied 20. This caused an out-of-bounds read and crashes. A logic error in the Content Validator let the file through. Fixes: staged deployment ("Every template instance will henceforth be deployed to customers in a staged roll-out"), customer control over Rapid Response Content deployment, and more testing including fuzzing. — [CrowdStrike RCA executive summary (PDF)](https://crowdstrike.com/wp-content/uploads/2024/08/Executive-Summary_Root-Cause-Analysis_Channel-File-291.pdf), [TechTarget](https://www.techtarget.com/searchSecurity/news/366602392/CrowdStrike-details-errors-that-led-to-mass-IT-outage)
- **User-side staging:** Coolify community practice is to "wait a few days before updating". Umbrel never auto-installs OS updates. — [coolify discussion #9538](https://github.com/coollabsio/coolify/discussions/9538), [Umbrel support](https://umbrel.com/support/basics/updating-umbrelos)
- **Upgrade gating on the host:** Coolify refuses to start an update if the pre-update DB backup fails. — [coolify.io upgrade docs](https://coolify.io/docs/get-started/upgrade)

### Inferences
- For Skiff, the cheapest and highest-value gates are:
  1. CI builds the exact artifact the host will run, then runs the *same* canary/migration step the host runs against fixture DBs from N-1, N-2 and an older baseline. A canary-step bug like the one Skiff just hit would then fail in CI, not on hosts.
  2. A signed channel manifest (`stable`/`beta`) that the release side can repoint or pin to "hold at X", which acts as the kill switch.
  3. An optional staggered rollout: hosts hash their node ID into a 0–100 bucket and update only when the manifest's `rollout_percent` ≥ bucket, a common pattern I did not find documented by these products.
- GitLab and Sentry upgrade stops exist because heavy migrations cannot be skipped. If Skiff's migrations ever become non-trivial, the manifest can encode `min_from_version` so a host far behind steps through an intermediate release.

### Gaps
- None of the self-hosted products retrieved document percentage-based staged rollout or CI "upgrade from N-1 on real data" suites. I found no source for whether HA, Coolify or ONCE run such tests. The best source on this is CrowdStrike's post-incident commitment.
- How HA or Coolify pull a bad release (repointing `stable.json`/`versions.json`) is implied by the architecture but not described in a retrieved postmortem.

## 5. Notable incidents where a self-update broke installations

### Takeaway
The recurring incident shapes are: (a) the updater itself is broken and cannot fetch its own fix (HA Supervisor 2022), (b) the old version is torn down before the new one is proven healthy (Coolify, Discourse), (c) the host environment is not what the build or release assumed (Docker versions, memory, architecture), and (d) a fleet-wide simultaneous push of an artifact that slipped past validation (CrowdStrike). The fixes that followed were out-of-band recovery scripts, channel separation, more testing, staged rollout and pre-update backups that gate the update.

### Cited Findings
- **HA Supervisor, Nov 2022:** Supervisor 2022.11.0 / 2022.11.dev1401 on beta/dev "prevents the Supervisor from working properly and from updating itself to a working version". One update stalled for more than 10 hours, and after reboot Core did not restart. Recovery was an **out-of-band** script served from the version server: `curl -o - https://version.home-assistant.io/update-supervisor.txt | sh`, which "restores your Supervisor to the latest working version". The alternative was reinstalling and restoring a backup. The stated root issue was "the inability to update supervisor when supervisor isn't working"; the fix was "The bug has been fixed and testing increased accordingly." — [HA community, 16 Nov 2022](https://community.home-assistant.io/t/supervisor-november-beta-issue-impacting-users-on-home-assistant-beta-dev-channels/489895) (older material, still the clearest analogue)
- **HA Supervisor, other years:** users had to manually pull a known-good Supervisor image, retag it as `latest`, clear the startup marker and restart. A Docker 25 upgrade broke Supervisor networking. — [supervisor#4003](https://github.com/home-assistant/supervisor/issues/4003), [supervisor#4827](https://github.com/home-assistant/supervisor/issues/4827), [HA community 2022](https://community.home-assistant.io/t/latest-supervisor-wont-start/437311?page=4)
- **HAOS boot-slot confusion:** an update went to slot B but the device booted A and showed the old version, and the user had to change boot order by hand. — [HA community: HAOS stuck on 15.2](https://community.home-assistant.io/t/haos-stuck-on-version-15-2/945485) (anecdotal)
- **Coolify:** beta.398 upgrade left the instance unreachable, and neither upgrade nor downgrade recovered it. beta.418→432 upgrade never finished. These are per-instance reports. I found no fleet-wide Coolify postmortem. — [coolify#5288](https://github.lhy31512.workers.dev/coollabsio/coolify/issues/5288), [coolify#6732](https://github.com/coollabsio/coolify/issues/6732)
- **Discourse:** a failed rebuild left Redis unable to start and no runnable old container. — [Meta: Rollback upgrades](https://meta.discourse.org/t/rollback-upgrades/116074)
- **Umbrel:** nodes stuck at "Restarting" and never returning after OS updates. — [Umbrel community](https://community.umbrel.com/t/updated-os-now-node-dead/25434)
- **CrowdStrike, July 2024:** see section 4. — [RCA summary](https://crowdstrike.com/wp-content/uploads/2024/08/Executive-Summary_Root-Cause-Analysis_Channel-File-291.pdf)

### Inferences
- Skiff's incident (a canary-step bug stalled updates, and failed commits were recorded and skipped) is the HA 2022 shape: the mechanism that applies fixes was the broken component. HA got out because it had an out-of-band path (a script on the version server, plus a fresh install that pulls stable) that did not depend on the broken Supervisor's update logic.
- "Record failed commit and skip it" is safe only if the *failure attribution* is correct. If the updater is at fault, every new release is recorded as failed and skipped. That is how a single updater bug becomes a permanent update block.

### Gaps
- I found no reliable primary source on a Synology DSM update bricking incident or a GitLab Omnibus self-update postmortem this session.
- No Coolify-wide incident postmortem was found. If one exists, it is likely on Discord or X rather than in the docs or on GitHub.

## 6. The updater updating itself: avoiding "an updater bug blocks all future updates"

### Takeaway
Three proven patterns exist:
1. **Separate, rarely changing updater** with a different release cadence from the payload (ONCE binary vs app images; HAOS RAUC and bootloader vs Supervisor; Caddy/Tailscale binary replace).
2. **Side-by-side versioned updater with self-qualification before activation** (Chromium updater). A new updater that fails its self-test never becomes active, and the old one keeps working.
3. **Out-of-band recovery path** that does not run through the updater (HA's `update-supervisor.txt` script; fresh install plus backup restore; Coolify's terminal `upgrade.sh <version>`).

On top of these, bootloader-style "the new version must positively mark itself good, otherwise fall back" (HAOS) handles the case where the new code hangs.

### Cited Findings
- **Chromium updater:** "Each updater instance is unpacked into a version-specific subdirectory"; "only one such instance is _active_." New instances start `Unqualified` and "perform a self-test before activating". They register a qualification app, check for an update to it, download and apply it, and only then become `Qualified`. Activation takes a global prefs lock and sets a "swapping" bit so an interrupted activation "will recover and restart activation". Replaced instances discover this at startup and "uninstall themselves". If the active version number decreases, the instance "will have to qualify itself again before reactivating". — [Chromium updater design doc](https://chromium.googlesource.com/chromium/src/+/main/docs/updater/design_doc.md)
- **HAOS layering:** the RAUC/bootloader layer (in the OS image) decides rollback. The Supervisor (a separately updated container) only marks the slot good after it starts, so a broken Supervisor causes a fallback of the OS slot and does not brick the device. — [HA update system](https://contributors.home-assistant.io/os/operating-system/update-system/)
- **HA out-of-band recovery:** `version.home-assistant.io/update-supervisor.txt` restores the latest working Supervisor when the Supervisor cannot update itself. — [HA community 2022](https://community.home-assistant.io/t/supervisor-november-beta-issue-impacting-users-on-home-assistant-beta-dev-channels/489895)
- **ONCE separation:** `once self-update` (CLI binary from GitHub Releases) is a different code path and cadence from app updates (image pull plus kamal-proxy health-gated swap). An app update bug does not affect the ability to self-update the CLI, and vice versa. — [once self_update.go](https://github.com/basecamp/once/blob/main/internal/command/self_update.go), [application.go](https://github.com/basecamp/once/blob/main/internal/docker/application.go)
- **Caddy:** backs up the current binary beside itself and restores it automatically if the upgrade fails. — [caddyserver.com command line](https://caddyserver.com/docs/command-line)
- **Tailscale:** root keys compiled into the client mean a very old client may fail verification of new artifacts. The error message explicitly anticipates "a very old client with outdated root keys", so the trust-bootstrap itself can strand old updaters. — [distsign](https://pkg.go.dev/tailscale.com@v1.84.3/clientupdate/distsign)
- **Coolify:** the updater logic (upgrade.sh) is fetched fresh from the CDN on every run, so the release side can fix it without the instance's own code being correct. Downgrade or recovery is the same script with an explicit version from the terminal. — [Coolify downgrade docs](https://coolify.io/docs/core/instance-management/downgrade), [upgrade.sh](https://raw.githubusercontent.com/coollabsio/coolify/main/scripts/upgrade.sh)

### Inferences
- A Skiff design that applies these patterns:
  1. Split a **tiny, stable "stage-0" updater** (download → verify signature → unpack to `releases/<version>` → atomic symlink flip → start → wait for positive health → else flip back). It changes rarely and is version-pinned separately.
  2. Move release-specific checks (canary boot, migration dry-run) **into the new release**, invoked by stage-0 as `new/bin/skiff self-check --db-copy …`. A bug in a release's own check then fails only that release. The next release ships a fixed check, and stage-0 is unaffected.
  3. Have the next release's manifest able to say `force_retry: [commits…]` or simply supersede skipped versions. Never let a skip list block versions newer than the failing one.
  4. Keep an **out-of-band recovery** command, e.g. `curl …/recover.sh | sh -s <version>` or `skiffctl rollback`, that does not depend on the running control plane.
  5. Use the HAOS rule: the new version must positively report healthy within N seconds or N boots, and silence counts as failure.
- When stage-0 itself must change, it can use Chromium's approach: install the new stage-0 side-by-side, have it qualify by performing a dry-run update of a no-op payload, then activate. A broken new stage-0 never takes over.
- Blue/green at the service level (two Skiff instances behind the edge proxy, switch after health) is the same mechanism as ONCE/Kamal. It helps with zero-downtime and health-gated cutover, but it does not on its own fix updater-logic bugs or on-host build failures. Those need prebuilt artifacts and a stage-0/stage-1 split.

### Gaps
- I found no documentation of Sparkle, Squirrel or Omaha-style "updater ships with the release" patterns beyond Chromium's design doc.
- There was no first-party doc on how ONCE updates the `once` background service binary safely while it is running (`replaceBinary` and the service restart were not fully read).
