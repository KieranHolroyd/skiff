# Testing

Two layers matter for managed data:

1. **`bun test`** — unit tests and fakes for services, renderers and reconciliation loops.
2. **`tests/e2e/managed-data.e2e.ts`** — disposable Postgres 17 + RustFS 1.0.4 containers on a
   private network. It asserts the wire-level contract the helper, agent and object browser use.

The Debian 13 wrapper is `scripts/e2e/debian13.sh`. It verifies the real host prerequisites and
runs the container lane; the privileged helper/Quadlet path is a documented manual checklist
below, not something the harness pretends to do.

---

## Quick start

```sh
# bun 1.4.x, plus Podman (preferred) or Docker
bun install --frozen-lockfile

# Auto-detect Podman, then Docker. Skips with exit 0 when neither is usable.
bun tests/e2e/managed-data.e2e.ts

# Require one engine (CI does this, so a missing engine is a failure)
YOAL_E2E_ENGINE=podman bun tests/e2e/managed-data.e2e.ts
YOAL_E2E_ENGINE=docker bun tests/e2e/managed-data.e2e.ts

# Force the skip path (useful for offline development)
YOAL_E2E_ENGINE=none bun tests/e2e/managed-data.e2e.ts
```

On macOS with Podman, start the machine first: `podman machine init && podman machine start`.
Docker Desktop works unchanged and is the fallback engine.

The harness prints `PASS`/`FAIL` per check and exits non-zero if any check fails. It creates a
temporary directory, starts labelled containers and a private network, and removes all of them in
a `finally` block (including on interrupt). No state survives the run and no root is required.

### Environment variables

| Variable | Purpose |
|---|---|
| `YOAL_E2E_ENGINE` | `podman`, `docker`, or `none`. Unset auto-detects; an explicit engine that is unavailable is a hard failure. |
| `YOAL_E2E_PODMAN_SUDO` | Set to `1` to run `sudo podman` (rootful node). Default is rootless. |
| `YOAL_E2E_SKIP_OS_CHECK` | Used by `scripts/e2e/debian13.sh` to test the wrapper off Debian 13. |

---

## What is covered

| Check | Contract it protects |
|---|---|
| Private network membership | Both containers join the same network; the helper aliases (`db-<id>`, `s3-<id>`) depend on it. |
| Postgres 17 starts / `pg_isready` | Pinned image and published loopback port. |
| Agent SSLRequest health probe | `apps/agent` treats a raw TCP accept as insufficient; a real Postgres must answer `S`/`N`. |
| Create database + connect | Deterministic role/password, a fresh database, and `SELECT 1` through Bun's Postgres client (`apps/agent/src/database-stats.ts`). |
| Deterministic fixture | 100 rows with a reproducible checksum, not just "one row exists". |
| `pg_dump -Fc` artifact | The helper's fixed dump profile produces a non-empty custom-format dump in the temp dir. |
| Restore into a fresh instance | `pg_restore --clean --if-exists --no-owner --exit-on-error` against a second container, then `SELECT 1` and the same row count/sum/checksum. |
| RustFS `/health` | Pinned image starts with the helper's `RUSTFS_*` profile. |
| Bucket create/list | `RustfsApi` (`apps/agent/src/storage-admin.ts`), the agent's real admin client. |
| Object browser PUT/HEAD/GET | `S3Client` from `packages/core/src/storage-s3.ts`, the control-plane object-browser client. |
| Browser list prefix/delimiter | Folder navigation shape used by the dashboard. |
| Presigned GET + tamper rejection | `presignPublicUrl` round-trip, and a modified `X-Amz-Signature` is refused. |
| Range GET | `Range: bytes=0-4` returns `206` and the exact prefix. |
| Multipart upload | SigV4 initiate/upload/complete with a 6 MiB deterministic body and SHA-256 compare. |
| Bulk delete | The browser's `deleteObjects` deletes and reports keys; a deleted key is unreadable. |
| Non-empty bucket delete | RustFS refuses deletion until the bucket is empty, then deletes it. |

These are real assertions with exit-code semantics, so a change to an image tag, credentials,
network mode, dump flags, SigV4 shape or the object-browser XML handling fails the lane.

---

## CI

`.github/workflows/ci.yml` has a `managed-data-e2e` job. A small `changes` job gates it on pull
requests touching:

- `apps/helper/**`, `apps/agent/**`
- `packages/core/src/database*`, `packages/core/src/storage*`, `packages/core/src/object-store*`
- `tests/e2e/**`, `scripts/e2e/**`, the workflow itself

On `main` pushes the lane runs unconditionally. The job installs Podman (`apt-get install podman`)
and runs:

```sh
YOAL_E2E_ENGINE=podman bun tests/e2e/managed-data.e2e.ts
```

GitHub's `ubuntu-latest` image provides Podman 4.9, not the Debian 13 baseline (Podman >= 5). The
container-level checks are version-independent, so the job is meaningful, but it is **not** the
real-node lane. The harness prints a warning when it sees Podman < 5.

---

## Debian 13 / Podman >= 5 / netavark

On a disposable Debian 13 (trixie) host:

```sh
apt-get update
apt-get install -y podman uidmap passt netavark aardvark-dns dbus-user-session
loginctl enable-linger "$USER"

git clone <repo> && cd private-cloud-deploys
bun install --frozen-lockfile

./scripts/e2e/debian13.sh --check-host   # OS, Podman >= 5, netavark, subuid, systemd --user
./scripts/e2e/debian13.sh                # the container-level lane
./scripts/e2e/debian13.sh --print-checklist
```

The host check fails when the OS is not Debian 13, Podman is older than 5, `podman info` fails, or
netavark is not the active network backend. Rootless warnings (subuid, linger, user systemd) are
printed as warnings because the container lane can still run without them; the Quadlet cases
cannot.

### Manual helper / agent / Quadlet checklist

This is the part the container lane intentionally does not fake. Run it after the container lane
is green, on the node that will run managed data:

1. **Host** — the packages and `loginctl enable-linger` commands above. `systemctl --user` must
   work for the agent user.
2. **Build** — `(cd apps/helper && bun run build)` and `(cd apps/agent && bun run build)`.
3. **Helper** — run `yoal-helper` as root (it refuses uid != 0) with
   `YOAL_HELPER_SOCKET=/run/yoal-helper/helper.sock`,
   `YOAL_HELPER_QUADLET_DIR=/etc/containers/systemd`,
   `YOAL_HELPER_STATE_DIR=/var/lib/yoal-workloads`,
   `YOAL_HELPER_CONTROL_SOCKET_GROUP=yoal`. It must create a `0660 root:yoal` socket and
   `systemctl`/`podman` must be at the configured absolute paths.
4. **Agent** — enrol with `bun run scripts/dev/enroll-agent.ts` (or the installer), add the node to
   the control plane, start `yoal-agent` as the `yoal` user.
5. **Verify** — `journalctl -u yoal-helper -u yoal-agent -f`, `podman ps --filter label=yoal`,
   `systemctl list-units 'yoal-workload-*'`, `ls /etc/containers/systemd`, and create/attach a
   database from the dashboard. Confirm:
   - the Quadlet `.container`/`.network` units are generated and the slice exists;
   - the data dir is owned by uid 70 and the container runs with `ReadOnly=true`;
   - an app on the network resolves `db-<id>` (or `s3-<id>`);
   - a backup reaches the configured object store and a restore into a new database answers
     `SELECT 1`;
   - `pg_dump`/`pg_restore` succeed through the helper's fixed verbs (not a shell from the wire).

Record the kernel, `podman --version` and `podman info` with the result.

---

## Known gaps

- **Privileged helper / systemd / Quadlet / netavark aliases are not automated.** The container
  lane cannot run the helper as root, install units, or prove user/mount ownership. That is the
  manual checklist above, and it remains the release gate for destructive managed-data flags.
- **App-container user namespaces are not exercised here.** Project and runner units render
  `UserNS=auto:size=65536` and use `:U` on `/data`, read-write volumes and the secret files; the
  helper adds the `containers` range to `/etc/subuid` and `/etc/subgid` before the first start. A
  live node must confirm that Podman accepts the unit, that `:U` re-owns an existing root-owned
  `/data` on the first start, that `ro,Z,U` and `ro,Z` mounts are accepted, and that a read-only
  reader can read what another workload wrote under the permissions it set.
- **Control-plane REST/MCP routes are not in this lane.** `tests/rest.e2e.ts` and
  `tests/mcp-oauth.e2e.ts` cover surfaces; this harness calls the service-layer clients
  (`RustfsApi`, `S3Client`, Bun SQL) against real containers. A route/auth regression needs the
  existing e2e suites.
- **PITR, 1 GB dumps, pooler, extensions, rotation, disks, public TLS and cross-node
  WireGuard** are not in Wave 0. They stay covered by unit/renderer tests and need feature-lane
  cases after plans 01–07 land.
- **No quota/RSS assertion** for the edge baseline; this lane checks behaviour, not memory.
- The RustFS image is pulled by tag `rustfs/rustfs:1.0.4` here. The helper still pins the digest
  from `apps/helper/src/validate.ts`; a digest mismatch is caught by helper unit tests, not by this
  lane.
