# A/B and Atomic Update Systems: Mechanisms and Invariants That Make Updaters Hard to Brick

Research date: 2026-11-05. Most sources are current living docs (source.android.com, systemd.io, freedesktop man pages, rauc/mender/bootc docs). Older material is flagged where it applies, especially the ChromeOS design docs (undated, early-design era, about 2009-2010) and a 2019 NixOS IRC log.

## 1. How do Android A/B, ChromeOS, OSTree/rpm-ostree/bootc, NixOS, systemd-sysupdate plus boot assessment, Mender, RAUC and SWUpdate structure an update?

### Takeaway
They nearly all share one four-step shape:
1. Write the new version into an inactive slot or deployment that the running system never touches.
2. Verify that copy.
3. Flip a single pointer (bootloader slot flag, symlink, or boot entry name) to make it "next".
4. Treat it as a trial until a health signal "commits" it. Without that signal, a counter or bootloader falls back to the previous version, which was left intact.

SWUpdate's default single-copy mode is the notable exception: it trades this guarantee for space and relies on a recovery initrd.

### Cited Findings

**Android A/B (seamless)**
- Uses "two sets of partitions referred to as slots". The system runs from the current slot and the unused slot is the fallback — [Android A/B](https://source.android.com/docs/core/ota/ab)
- Each slot has three attributes. *Bootable* means it holds a correct, bootable system. *Active* means it is the one the bootloader boots next. *Successful* is set by user space; "A successful slot should be able to boot, run, and update itself." — [Android A/B](https://source.android.com/docs/core/ota/ab)
- `update_engine` is a background daemon. It writes only to the unused slot, applies the payload operations, then re-reads and verifies the whole partitions. Only after that does it call `setActiveBootSlot()`. The doc warns: "Marking the unused slot as active doesn't mean it will finish booting." — [Android A/B](https://source.android.com/docs/core/ota/ab)
- Before writing anything, update_engine calls `markBootSuccessful()` on the current slot. This prevents fallback to the slot that is about to be overwritten. After the reboot, `update_verifier` marks the new slot successful once its dm-verity checks pass — [Android A/B](https://source.android.com/docs/core/ota/ab)
- A postinstall program runs from the new partition while the old OS is still running. It "must return with exit code 0" or the update fails. It runs under the old system's SELinux policy, so the old kernel must be able to mount and run the new formats — [Android A/B](https://source.android.com/docs/core/ota/ab)
- **Virtual A/B** (Android 11+) has no second physical slot. "the delta is written to a snapshot, and then merged into the base partition after confirming a successful boot." A merge interrupted by a reboot resumes after the reboot. "If the new OS fails to boot, devices automatically roll back to the previous version." From Android 13 the snapshots are served by the userspace `snapuserd` daemon through `dm-user` — [Android Virtual A/B](https://source.android.com/docs/core/ota/virtual_ab)

**ChromeOS** (design doc is undated and from the early ChromeOS era; treat it as historical)
- "Not even the autoupdater will edit the currently-booted root file system." Updates are written only to the other root partition — [Chromium OS Filesystem/Autoupdate](https://www.chromium.org/chromium-os/chromiumos-design-docs/filesystem-autoupdate/)
- After an update, the new partition gets a `remaining_attempts` counter ("currently 6") stored in spare GPT bits. The bootloader decrements it on each attempt. When no partition has attempts left, it boots the partition marked bootable — [Chromium OS Filesystem/Autoupdate](https://www.chromium.org/chromium-os/chromiumos-design-docs/filesystem-autoupdate/)
- Success definition: "We consider a boot successful if the updater process can successfully launch". In other words, a good build must at least be able to update itself again — [Chromium OS Filesystem/Autoupdate](https://www.chromium.org/chromium-os/chromiumos-design-docs/filesystem-autoupdate/)
- Firmware is updated only "after successful boot of a new image that contains new firmware to install." The supplement calls itself an early design that may change — [ChromeOS FS/Autoupdate supplements](https://www.chromium.org/chromium-os/chromiumos-design-docs/filesystem-autoupdate-supplements/)

**OSTree / rpm-ostree / bootc**
- "If the system crashes or you pull the power, you will have either the old system, or the new one." The currently booted deployment must always be in the new set of bootable deployments — [OSTree atomic upgrades](https://ostreedev.github.io/ostree/atomic-upgrades/)
- The new deployment is built as a hardlink farm, checksum-verified per object, while the running system and bootloader config stay untouched. The atomic step is the swap of `/boot` → `/ostree/boot.[0|1]`: the inactive directory is populated, then the symlink is switched in one step — [OSTree atomic upgrades](https://ostreedev.github.io/ostree/atomic-upgrades/)
- `/etc` gets a 3-way merge. Locally modified files are kept. Files that still match the old default are upgraded to the new default — [OSTree atomic upgrades](https://ostreedev.github.io/ostree/atomic-upgrades/)
- `bootc upgrade` will "Download and queue an updated container image to apply". "This does not affect the running system." By default the staged deployment is finalized at shutdown by `ostree-finalize-staged.service`. `--apply` reboots immediately and `--soft-reboot` is also supported. `--download-only` and `--from-downloaded` split fetching from applying — [bootc-upgrade(8)](https://bootc.dev/bootc/man/bootc-upgrade.8.html)
- **greenboot** adds the health-check and auto-rollback layer on rpm-ostree systems; see Q2. The shell version is now deprecated in favour of greenboot-rs (0.16.0+) — [greenboot](https://github.com/fedora-iot/greenboot)

**NixOS generations**
- `nixos-rebuild switch` builds the configuration, makes it the boot default and activates it. `test` activates it without making it the boot default, so "just reboot to get back to a working configuration". `boot` sets it as the boot default without activating it. Every change adds a boot-menu entry, which "allows you to easily roll back to a previous configuration if something goes wrong" — [NixOS manual](https://nixos.org/manual/nixos/stable/#sec-rollback)

**systemd-sysupdate plus Automatic Boot Assessment**
- Each `*.transfer` file has Source (url-file, url-tar, regular-file, tar, directory, subvolume) and Target (partition, regular-file, directory, subvolume) sections. Versions are matched with `@v` patterns. `InstancesMax=` limits how many versions are kept. `ProtectVersion=%A` stops the running version from being removed. `CurrentSymlink=` maintains a stable symlink to the newest completed install. `Verify=` checks `SHA256SUMS.gpg` and "is essential to provide integrity guarantees" — [sysupdate.d(5)](https://www.freedesktop.org/software/systemd/man/latest/sysupdate.d.html)
- Caveat from the same page: across multiple transfers, the final rename step "is not atomic, however it is guaranteed to be executed strictly in order". For that reason the entry-point transfer should sort last — [sysupdate.d(5)](https://www.freedesktop.org/software/systemd/man/latest/sysupdate.d.html)
- Boot counting is encoded in the boot entry filename (`+LEFT-DONE`, e.g. `+3` → `+2-1` → `+1-2` → `+0-3`). systemd-boot renames the file on every attempt. `systemd-bless-boot.service` removes the counter once `boot-complete.target` is reached. An entry at `+0` is "bad" and sorts after all good entries, so the previous version boots — [systemd Automatic Boot Assessment](https://systemd.io/AUTOMATIC_BOOT_ASSESSMENT/)

**Mender**
- Mender is a state machine: Download → ArtifactInstall → ArtifactReboot → ArtifactCommit, with failure paths ArtifactRollback → ArtifactRollbackReboot → ArtifactFailure. "rootfs-image Artifacts will always reboot." — [Mender state scripts](https://docs.mender.io/artifact-creation/state-scripts)
- Commit is the point of no return. At ArtifactCommit_Leave "it is too late to go to an Error script, because the Artifact has already been committed" — [Mender state scripts](https://docs.mender.io/artifact-creation/state-scripts)

**RAUC**
- Bundles are SquashFS images with a manifest, and "signing a bundle is mandatory". A bundle "should always unambiguously describe the intended target state of the entire system." — [RAUC basics](https://rauc.readthedocs.io/en/latest/basic.html)
- Slot target mapping "must contain only inactive slots, and not accidentally a slot that the system currently runs from." RAUC detects the booted slot from the kernel command line or mounts. It deactivates a slot in the bootloader before writing to it and reactivates it only after a successful install — [RAUC basics](https://rauc.readthedocs.io/en/latest/basic.html)
- RAUC allows any number of redundant slots per class (not only A/B). Among inactive groups it picks the one with the oldest install timestamp — [RAUC basics](https://rauc.readthedocs.io/en/latest/basic.html)

**SWUpdate**
- SWUpdate is usually single-copy, "running in an initrd". Double-copy is possible through "Software collections" — [SWUpdate docs](https://sbabic.github.io/swupdate/swupdate.html)
- On U-Boot it relies on a redundant environment ("two copies of the environment to be power-off safe"). On GRUB, variables are written to a temp file and then renamed. A boot counter can automatically start SWUpdate to replace corrupt software. Images are "authenticated and verified before installing" — [SWUpdate docs](https://sbabic.github.io/swupdate/swupdate.html)

### Inferences
- The common pattern is a staged copy, a single pointer flip, a trial period and a commit. Every system separates "installed" from "active" from "committed" (Android: bootable/active/successful; Mender: Install/Reboot/Commit; RAUC: install/mark-good).
- The "next" pointer is cheap and atomic. The expensive work (download, unpack, verify, postinstall) all happens before it, against a copy the running system does not depend on.
- SWUpdate single-copy shows the cost of skipping A/B: you then need a separate, independently bootable recovery environment.

### Gaps
- I did not fetch the current ChromeOS update_engine/GPT attribute docs (priority/tries/successful bits). Only the older design doc was available. The URL `chromiumos-design-docs/disk-format/` returned 404.
- I did not fetch the NixOS manual sections on profiles as symlinks (`/nix/var/nix/profiles/system-N-link`) or on `--rollback`. The manual page is about 700 KB and only the first 100 KB was read.
- I did not fetch the full ostree "Atomic Rollbacks" and "/var handling" pages.

## 2. What does "mark good only after a health check, otherwise auto-revert" look like concretely?

### Takeaway
A counter is armed *before* the trial boot or start, and is decremented by something that runs *before* the new code: a bootloader, or a supervisor that is not part of the payload. Only an explicit positive signal (bless, mark-good, commit) clears it. Silence, a hang, a crash or a reboot all count as failure by default.

Health checks are pluggable units ordered before a single "complete" target. A hardware or software watchdog turns hangs into resets, so hangs also count.

### Cited Findings
- **systemd:** `boot-complete.target` is the extension point. Health-check units are ordered `Before=` it and are required by it ("the target unit shall pull in these boot checking units, not the other way around"). `systemd-boot-check-no-failures.service` is a ready-made check that fails the boot if any unit failed. A check started after the target is reached will not gate the boot. `systemd-bless-boot bad` marks the entry bad immediately. Rebooting on failure is "orthogonal" and done with `FailureAction=` — [systemd Automatic Boot Assessment](https://systemd.io/AUTOMATIC_BOOT_ASSESSMENT/)
- **Android:** `update_verifier` runs after the reboot and marks the slot successful only after dm-verity verification passes. The bootloader makes "some number of attempts" before marking a slot unbootable and falling back. No fixed count is mandated — [Android A/B](https://source.android.com/docs/core/ota/ab)
- **ChromeOS (old doc):** 6 attempts. The success criterion is that the updater itself launches — [Chromium OS Filesystem/Autoupdate](https://www.chromium.org/chromium-os/chromiumos-design-docs/filesystem-autoupdate/)
- **greenboot:** scripts in `required.d` fail the boot on a non-zero exit. `wanted.d` scripts may fail without failing the boot. `green.d`/`red.d` run after the verdict. `greenboot-grub2-set-success.service` unsets the GRUB `boot_counter` and sets `boot_success=1`. If `boot_counter` reaches -1, a pre-check service runs `rpm-ostree rollback`. On failure, `redboot.target` runs and then auto-reboots. `GREENBOOT_MAX_BOOT_ATTEMPTS` caps the attempts. There is also a watchdog check with a grace period (default 24 h) — [greenboot](https://github.com/fedora-iot/greenboot)
- **Mender:** health and sanity checks belong in `ArtifactCommit_Enter`. A non-zero exit (1) rolls the update back. Exit 21 means "retry later", bounded by `StateScriptRetryTimeoutSeconds`. Every script has a hard `StateScriptTimeoutSeconds`; when it is exceeded "its process group will be killed and the Mender Client will treat the script and the update as failed." Power loss before commit leads to ArtifactRollback/ArtifactFailure, and those error states "repeat until they succeed" — [Mender state scripts](https://docs.mender.io/artifact-creation/state-scripts)
- **RAUC:** userspace reports the result with `rauc status mark-good` / `mark-bad`. The docs note that detecting a failed boot "is often not possible". They recommend a hardware watchdog plus bootloader detection of watchdog resets as failed boots. What happens next "is up to your bootloader" — [RAUC basics](https://rauc.readthedocs.io/en/latest/basic.html)
- **SWUpdate/U-Boot:** a boot counter lets U-Boot "track for attempts to successfully run the application". When the limit is exceeded, `altbootcmd` runs the fallback — [SWUpdate docs](https://sbabic.github.io/swupdate/swupdate.html)

### Inferences
- **Who decides:** in every system the arbiter of "did it work" is *not* the new version's own code path. It is the bootloader, a separate verifier daemon, or an external client. The new version can only vote "good" by reaching a target. It cannot veto a fallback.
- **Default-to-revert:** the counter is decremented before the trial runs. A crash, a hang or a kill therefore leaves the counter lower, and the system converges on the old version without any code having to "handle" the failure.
- **Bounded time:** every check has a hard timeout (Mender per-script timeouts, the greenboot watchdog grace period, systemd job timeouts). A hang can't keep the system on an unblessed version forever.
- **Application-level translation:** "mark good" means writing a small committed marker, such as the `current` symlink target or a `good` file, only after HTTP health plus DB checks pass within N seconds. A separate systemd unit, not the new app, owns the trial counter.

### Gaps
- Default retry counts differ and are often not documented: Android doesn't mandate one, and greenboot's default `GREENBOOT_MAX_BOOT_ATTEMPTS` was not stated on the page.

## 3. Which invariants do these systems state explicitly?

### Takeaway
Five invariants are stated, nearly verbatim, across projects:
1. Never modify the running version.
2. Make the switch a single atomic pointer flip, done after full verification.
3. Keep the old version bootable until the new one is committed.
4. Only signed and verified payloads are installed.
5. Interruption at any point leaves either the old or the new version, never a mix.

### Cited Findings
- **Never touch the running version:** "no partition used by the *current* slot should be updated as part of the OTA update" — [Android A/B](https://source.android.com/docs/core/ota/ab). "Not even the autoupdater will edit the currently-booted root file system" — [ChromeOS](https://www.chromium.org/chromium-os/chromiumos-design-docs/filesystem-autoupdate/). The slot mapping "must contain only inactive slots" — [RAUC](https://rauc.readthedocs.io/en/latest/basic.html). "This does not affect the running system" — [bootc](https://bootc.dev/bootc/man/bootc-upgrade.8.html). `ProtectVersion=%A` stops the running version being removed — [sysupdate.d](https://www.freedesktop.org/software/systemd/man/latest/sysupdate.d.html)
- **Old or new, never mixed:** "you will have either the old system, or the new one" — [OSTree](https://ostreedev.github.io/ostree/atomic-upgrades/). The update "is either considered fully installed or not, independent of possible interruptions" — [Pengutronix 2019](https://www.pengutronix.de/en/blog/2019-08-16-rauc_maintenance.html)
- **Booted version stays in the bootable set:** "The currently booted deployment must always be in the new set" — [OSTree](https://ostreedev.github.io/ostree/atomic-upgrades/)
- **Single atomic switch:** OSTree swaps the `/boot` symlink in one step — [OSTree](https://ostreedev.github.io/ostree/atomic-upgrades/). Android sets the active slot only after writing and verifying everything — [Android A/B](https://source.android.com/docs/core/ota/ab)
- **The counter-example matters:** systemd-sysupdate explicitly says a multi-transfer rename "is not atomic". It is only strictly ordered, with the entry point last. Atomicity comes from making the *last* rename the only thing the system resolves at start — [sysupdate.d](https://www.freedesktop.org/software/systemd/man/latest/sysupdate.d.html)
- **The fallback must not be destroyed first:** Android marks the *current* slot successful before overwriting the other one, so it never falls back into a half-written slot — [Android A/B](https://source.android.com/docs/core/ota/ab). RAUC deactivates a slot before writing it — [RAUC](https://rauc.readthedocs.io/en/latest/basic.html)
- **Verify before activate, always:**
  - Signing is mandatory in RAUC — [RAUC](https://rauc.readthedocs.io/en/latest/basic.html)
  - Android re-reads and verifies the partitions before switching — [Android A/B](https://source.android.com/docs/core/ota/ab)
  - sysupdate checks SHA256 always and GPG when `Verify=` is set — [sysupdate.d](https://www.freedesktop.org/software/systemd/man/latest/sysupdate.d.html)
  - OSTree validates the checksum of every object — [OSTree](https://ostreedev.github.io/ostree/atomic-upgrades/)
- **Declarative target state:** a bundle "should always unambiguously describe the intended target state of the entire system" — [RAUC](https://rauc.readthedocs.io/en/latest/basic.html)
- **The updater itself stays updatable and compatible:**
  - ChromeOS defines success as "the updater process can successfully launch" — [ChromeOS](https://www.chromium.org/chromium-os/chromiumos-design-docs/filesystem-autoupdate/)
  - Android defines a successful slot as one that can "boot, run, and update itself" — [Android A/B](https://source.android.com/docs/core/ota/ab)
  - New RAUC bundle features must be explicitly enabled, so older RAUC can still install newer bundles — [RAUC](https://rauc.readthedocs.io/en/latest/basic.html)
- **Retry is safe:** a failure while applying affects only the unused slot, and "the client is free to re-attempt the update" — [Android A/B](https://source.android.com/docs/core/ota/ab). Mender requires scripts to be idempotent — [Mender](https://docs.mender.io/artifact-creation/state-scripts)

### Inferences
- An invariant the user's current design violates: building from source on the host makes the build environment (toolchain, permissions, network) part of the update's critical path. In every system above, the payload arrives prebuilt and verified, and the client only copies, verifies and flips.
- "Can update itself" as the definition of healthy is a strong, transferable rule. A release that can't run the updater must never be committed.

### Gaps
- I found no single canonical "list of invariants" document. The invariants above are assembled from statements scattered across each project's docs.

## 4. How do they handle persistent data or state migrations?

### Takeaway
None of them makes data rollback free. The OS-level systems sidestep it by keeping the immutable system separate from one mutable state area that the updater doesn't version (Android `/data`, the ChromeOS stateful partition, OSTree `/var`, NixOS state). Migration then becomes the application's job.

The explicit hooks (Mender state scripts, RAUC bundle scripts, Android postinstall) put the burden of idempotency and of reverse migration on the author. Once committed, there is no going back.

### Cited Findings
- **Android:** updates must not modify "the contents of non-A/B partitions that can't be wiped with a factory reset" — [Android A/B](https://source.android.com/docs/core/ota/ab). Virtual A/B snapshots live on `/data` (about 3.8 GB, or about 2.1 GB compressed), and the merge happens only after a confirmed successful boot — [Virtual A/B](https://source.android.com/docs/core/ota/virtual_ab)
- **ChromeOS:** the read-write stateful partition holds "all state that needs to be stored locally". The root partitions are read-only — [ChromeOS](https://www.chromium.org/chromium-os/chromiumos-design-docs/filesystem-autoupdate/)
- **OSTree:** `/etc` gets a 3-way merge, and a modified file is kept "indefinitely" unless it later matches a new default — [OSTree](https://ostreedev.github.io/ostree/atomic-upgrades/)
- **Mender:**
  - Scripts "should be written to be idempotent".
  - The client does not track script side effects. If a script makes a permanent change, the author must plan the rollback (for example, back up a file in `ArtifactInstall_Enter` and restore it in `ArtifactRollback_Enter`).
  - The docs place data migration in `ArtifactInstall_Leave`, before the reboot, so the new version starts with migrated data.
  - An error in a script that the Error mechanism ignores leaves the artifact name with an `_INCONSISTENT` suffix.
  - Source: [Mender state scripts](https://docs.mender.io/artifact-creation/state-scripts)
- **RAUC:**
  - Bundles may carry scripts that run "before, during or after installation".
  - "Artifact repositories" hold containers, data and add-ons outside the slots, and the system "should treat them as read-only".
  - The basics page says nothing about data migration.
  - Source: [RAUC basics](https://rauc.readthedocs.io/en/latest/basic.html)
- **NixOS:** rollback affects only Nix-managed files. A service that migrated its DB schema can't be rolled back by switching generations — [NixOS Discourse](https://discourse.nixos.org/t/rolling-back-data-as-well-not-only-nix-config/63169). `system.stateVersion` exists so that default package versions don't silently change and break data compatibility, and shouldn't be bumped before the state is migrated — [nixpkgs option docs mirror](https://code.ornl.gov/nix/nixpkgs/-/commit/424b0cefa44c3b08e1f71ae48e3621a72931739a). A 2019 #nixos-dev log (old) records a Nextcloud service broken after `--rollback` — [logs.nix.samueldr.com](https://logs.nix.samueldr.com/nixos-dev/2019-04-05). Common practice is filesystem snapshots or backups of data dirs, e.g. a proposed ZFS snapshot before activation (merge status unknown) — [NixOS Discourse](https://discourse.nixos.org/t/rolling-back-data-as-well-not-only-nix-config/63169)
- **Portable services:** images stay read-only, and writable data lives on the host via `StateDirectory=` — [systemd Portable Services](https://systemd.io/PORTABLE_SERVICES/)

### Inferences
- For Yoal, SQLite is the "/data" problem. These are the transferable patterns:
  1. Snapshot the DB atomically before the trial. Use SQLite's online backup API or `VACUUM INTO`, keyed to the version.
  2. Make migrations expand-only (backwards-compatible) for at least one release, so release N-1 can still run against schema N. This mirrors RAUC's "older client can install newer bundle" compatibility rule.
  3. Treat any irreversible migration as happening at "commit". Like Mender's point of no return, it runs only after the health window, or else restore from the pre-update snapshot on rollback.
- Android's Virtual A/B "merge only after success" is the model for destructive steps. Defer anything that destroys the fallback, such as deleting the previous release or contracting schema migrations, until after mark-good.

### Gaps
- I did not fetch Android's userdata checkpointing docs (`checkpoint`, f2fs/ext4 rollback of /data on failed boot). This is the closest OS-level analogue to "roll back data with the system".
- I did not fetch RAUC's install-hook/slot-hook reference page, so its exact hook semantics are not cited here.
- I did not fetch SWUpdate's bootloader-interface page (ustate values, transaction marker).

## 5. Which of these mechanisms translate to a userspace service on one host?

### Takeaway
Nearly all of them translate: an immutable versioned release directory or image, verification, a single atomic pointer flip, a trial start supervised by systemd with an armed counter, mark-good or revert, and deferred garbage collection. systemd already ships most of the primitives: sysupdate transfers with `CurrentSymlink=`, `ProtectVersion=`, `InstancesMax=` and GPG verification; portable services with `reattach`; and `StateDirectory=` for data outside the image.

What does *not* translate is the bootloader as an independent arbiter. On a single host, the arbiter must be a separate small systemd unit, timer or path unit that is not upgraded in the same transaction as the app.

### Cited Findings
- `systemd-sysupdate` "may be used to update any kind of file from a remote source". Example 2 updates a container directory tree via `url-tar` into a `subvolume` with `CurrentSymlink=myContainer` — [sysupdate.d(5)](https://www.freedesktop.org/software/systemd/man/latest/sysupdate.d.html)
- sysupdate features that map to the app case:
  - `InstancesMax=` retention
  - `ProtectVersion=` to protect the running version
  - `Verify=` GPG over `SHA256SUMS`
  - `ReadOnly=` and `Mode=`
  - transfers applied strictly in order, entry point last
  - Source: [sysupdate.d(5)](https://www.freedesktop.org/software/systemd/man/latest/sysupdate.d.html)
- Portable services:
  - Image units are copied to `/etc/systemd/system.attached/` with `RootImage=` drop-ins.
  - "The portablectl reattach command combines a detach with an attach." It is meant for upgrades, allowing a restart and keeping fd-store state, but it is not described as atomic.
  - Images must "stay around (and in the same location)" while attached.
  - Versioned names like `foobar_0.7.23.raw` map to the `foobar` prefix.
  - Writable state goes in `StateDirectory=`.
  - Source: [systemd Portable Services](https://systemd.io/PORTABLE_SERVICES/)
- sysext/confext are OverlayFS-merged extension images. They need matching `SYSEXT_LEVEL=`/`VERSION_ID=` or `CONFEXT_LEVEL=` in their extension-release files — [systemd Portable Services](https://systemd.io/PORTABLE_SERVICES/)
- `boot-complete.target`'s pattern (checks ordered before a target, bless after it) is generic systemd ordering. Its own doc says alternative implementations "should keep using boot-complete.target" and should provide their own bless service and counter storage — [systemd Automatic Boot Assessment](https://systemd.io/AUTOMATIC_BOOT_ASSESSMENT/)
- OSTree's atomic step is a symlink swap of a fully populated directory — [OSTree](https://ostreedev.github.io/ostree/atomic-upgrades/). bootc splits `--download-only` from `--from-downloaded`, and offers `--soft-reboot` — [bootc-upgrade(8)](https://bootc.dev/bootc/man/bootc-upgrade.8.html)

### Inferences
These are proposed mappings, not sourced claims:
- **Slots → release directories:** `/opt/yoal/releases/<version>/`, read-only after unpack and verify, never edited in place.
- **Active pointer → `current` symlink:** replaced atomically with `ln -s new tmp && rename(tmp, current)`, since `rename(2)` over a symlink is atomic on POSIX. `previous` is kept as the fallback and never deleted until the new release is committed.
- **Boot counter → trial file:** for example `/var/lib/yoal/update/trial` containing `{version, tries_left, started_at}`. It is armed before the flip and decremented by the supervisor before each start of the service.
- **The supervisor** is a small updater/watchdog unit triggered on `yoal.service` failure via `OnFailure=` or a timer. It must not be replaced in the same transaction. Equivalently, `ExecStartPre=` logic lives outside the release directory.
- **boot-complete.target → health window:** an `ExecStartPost=` or separate oneshot health unit that polls `/health` and runs DB integrity checks, all with a hard timeout. On success it writes `committed`; otherwise the supervisor flips back.
- **Watchdog → `WatchdogSec=` with `sd_notify`:** Bun can send `WATCHDOG=1` via a notify socket helper, which converts hangs into restarts that consume tries. `Type=notify` gives a real readiness signal.
- **"Download, verify, stage" is separated from "apply":** like bootc's `--download-only`/`--from-downloaded`. The failure-prone parts (fetch, unpack, permissions) all happen in staging, while the old version runs, and a failure there can never change `current`.
- **Prebuilt, signed artifacts replace on-host builds:** sysupdate `url-tar` with `SHA256SUMS.gpg` is an off-the-shelf implementation. The canary permission bug is exactly the kind of failure this design isolates: it would fail in staging and never reach the flip.
- **systemd-sysupdate needs no bootloader for a directory target:** using `CurrentSymlink=` it is a plausible drop-in for fetch, verify, retain and symlink. It does *not* provide the trial and health part; you write that.

### Gaps
- I did not fetch the `systemd-sysupdate(8)` man page (the `--component`, `update`/`vacuum` verbs, and `sysupdate.d` per-component directories in recent systemd). Version requirements for the target distro are unverified.
- I found no source documenting a production userspace "boot assessment for services" built on `boot-complete.target`-style ordering. The mapping above is an inference.

## 6. Documented failure modes and postmortems, and lessons drawn

### Takeaway
The documented failures cluster into a few kinds:
- **Fallback that isn't independent:** a shared kernel or boot partition that the update doesn't cover, or corrupted rollback markers.
- **Failure that doesn't present as failure:** hangs with no visible error, so the counter doesn't trip promptly.
- **Rollback paths that were never tested.**
- **Content or config pushed without staged rollout or health gating:** CrowdStrike 2024.

The lessons are consistent:
- Version everything the release needs together.
- Fail fast and default to revert.
- Test the rollback path harder than the update path.
- Stage the rollout.

### Cited Findings
- **Hackaday OE5XRX log (2026-07-08)**, an A/B system with `bootcount`:
  - The trial slot hung at a blinking cursor, and the box stayed dead "until `bootcount` finally rolled it back".
  - Root cause: OTA rewrote only the rootfs, while the kernel lived on a static, unpinned boot partition. "the trial slot literally could not boot its own userland."
  - The panic was also invisible (`console=ttyS0` only).
  - Fixes: ship the kernel, modules and DTB inside each slot so a bad kernel is a bad slot. Keep only the bootloader static. Fail fast (no boot menu, zero timeout, reboot on fall-through). Make failures visible.
  - Source: [Hackaday.io log](https://hackaday.io/project/205911-oe5xrx-open-source-modular-remote-ham-station/log/249081-a-blinking-cursor-a-bricked-slot-and-making-ota-unbrickable)
- **Tuxera (vendor blog, automotive OTA):** the common symptoms are boot loops, rollback loops and units dead without physical access. It blames corrupted update and rollback markers and mixed states, where the system "has no single version of truth to validate against" — [Tuxera](https://www.tuxera.com/blog/ota-update-failures-vehicles-storage-risks/)
- **Datakey (vendor blog):** an OTA push left about 500 smart locks inoperable and unable to receive further OTA updates. The lesson drawn is that a fallback method is required. Treat with caution: the vendor is selling a product and the lock maker is not named — [Datakey](https://datakey.com/news/ota-firmware-update-bricks-hundreds-of-devices)
- **CrowdStrike Channel File 291 (July 2024; RCA published 2024-08-06):**
  - What went wrong: a content update expected 21 input fields but only 20 were supplied, causing an out-of-bounds read. A content-validator logic error let it through. Rapid Response Content was not subject to the same testing as code, and there was no staged rollout.
  - Remediations: canary then deployment rings with rollback, field-count validation, fuzzing, and customer control over rollout.
  - Sources: [CrowdStrike RCA blog](https://crowdstrike.com/blog/channel-file-291-rca-available), [Executive Summary PDF](https://crowdstrike.com/wp-content/uploads/2024/08/Executive-Summary_Root-Cause-Analysis_Channel-File-291.pdf), [TechTarget](https://www.techtarget.com/cybersecurity/news/366602392/CrowdStrike-details-errors-that-led-to-mass-IT-outage). Details came from secondary coverage and search snippets; the full PDF was not opened.
- **Pengutronix (2019):** field errors happen regardless of how intensively a new software state was tested, so the mechanism must tolerate bad releases — [Pengutronix](https://www.pengutronix.de/en/blog/2019-08-16-rauc_maintenance.html)
- **A 2026 comparison article** advises: "test the rollback path more thoroughly than the update path". The source is of unknown authority — [proteanos.com](https://proteanos.com/doc/ota-updates-rauc-swupdate-mender-2026)
- **Failure modes Android documents and designs for** — [Android A/B](https://source.android.com/docs/core/ota/ab):
  - I/O errors while applying are confined to the unused slot and can be retried.
  - Postinstall failure fails the update.
  - A boot failure falls back.
  - Verity corruption reboots.
  - Interruption by policy, reboot or the user can happen at any point.
  - A failed delta should be retried with a full package.
- **systemd's own documented pitfall:** a health check that starts after `boot-complete.target` is reached doesn't gate anything — [systemd Automatic Boot Assessment](https://systemd.io/AUTOMATIC_BOOT_ASSESSMENT/)
- **greenboot's documented pitfall:** a watchdog reset after the grace period is not treated as an update failure, and one inside the grace period marks red but "won't rollback" — [greenboot](https://github.com/fedora-iot/greenboot)
- **Mender's documented pitfall:** errors in scripts after commit can't roll back and leave `_INCONSISTENT` state — [Mender](https://docs.mender.io/artifact-creation/state-scripts)

### Inferences
- **Lesson for Yoal from the Hackaday case:** everything the new release needs must be inside the release or explicitly version-checked. That covers the Bun runtime version, native modules, unit-file drop-ins, file ownership and permissions, and Caddy config. Shared mutable pieces outside the "slot" are what break fallback.
- **Lesson for Yoal from the repeated canary permission failures:** the pre-flip stage behaved correctly (it blocked the flip), so the design worked as a safety net. The defect is that it never *makes progress*. "Can't fail" in mature systems means "can't leave the host broken", not "always succeeds". Reducing on-host variability makes success likely: prebuilt artifacts, fixed ownership baked in at packaging, and no host build.
- **Lesson from CrowdStrike:** treat config, content and migrations as part of the release, with the same verification and staged gating as code.
- Rollback loops (Tuxera) argue for a bounded number of total attempts. Once a version is marked bad, it shouldn't be auto-retried until a newer version appears (systemd's "bad entries sort last" semantics).

### Gaps
- I found no first-party postmortem from Android, ChromeOS, Mender, RAUC or OSTree maintainers of a fleet-bricking event. The postmortems found are small-project logs, vendor blogs, and the CrowdStrike RCA, which is not an OS updater.
- I did not retrieve conference talks (e.g. FOSDEM 2017 "Secure and Safe Updates for Your Embedded Device" by Enrico Jörns, RAUC). Only the listing was found — [FOSDEM 2017](https://archive.fosdem.org/2017/schedule/event/secure_safe_embedded_updates/)
