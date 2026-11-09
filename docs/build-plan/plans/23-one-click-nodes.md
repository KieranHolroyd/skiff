# 23 — One-command worker nodes (Yoal-managed WireGuard)

**Priority:** P1 · **Effort:** M–L · **Lane:** N (nodes/network)
**Depends on:** signed release artifacts (publish.yml, amd64 + arm64), the join token flow
(`packages/core/src/nodes.ts`, `apps/agent/src/join.ts`), the root helper's fixed-verb surface
**Supersedes:** ROADMAP's "WireGuard itself is host provisioned" and the 15-step manual guide at
`/nodes/vpn`. Refines D4 (proposed D98 below).
**Primary files:** `apps/helper/src/{server,validate}.ts` + new `apps/helper/src/wireguard.ts`,
`apps/agent/src/join.ts`, `packages/core/src/nodes.ts`, `packages/db/src/{schema,migrations}.ts`,
`packages/contracts/src/index.ts`, `scripts/install/main.ts`, new `scripts/install/node.sh`
(served by the control plane), `apps/control-plane/src/routes/(dashboard)/nodes/**`

> **Status (6 Nov 2026):** Proposal. Research summary is at the end of this file. Its single
> edge hub is generalised to hubs plus LAN mesh in [CLUSTERING.md](../../CLUSTERING.md) §4.1, so
> several ingress nodes don't make one hub a single point of failure. "Proposed D98" below was
> never adopted under that number (D98 is the edge hand-off).

## Problem

To add a worker today, the operator works through `/nodes/vpn` by hand on two machines. They
generate WireGuard keys on both, paste public keys across, write two `wg0.conf` files, open
firewall ports, pin the platform host in `/etc/hosts`, and install Caddy. Then they create
users, directories and tmpfiles, copy or build the agent binary, write `yoal.env`, write three
or four systemd units, and finally run `yoal-agent join --public-address <tunnel-ip>:<port>`.
A typo at any step gives a node that silently never comes online. The edge's own `wg0` is also
hand-provisioned.

## Goal

**Dashboard → Add node → copy one command → paste it on the machine as root → the node turns
green.** No key exchange, no IP planning, no firewall edits, no `/etc/hosts`, and nothing to
run on the edge. It must work behind CGNAT with no inbound ports on the worker.

The control plane cannot run code on a machine it has never touched, so one paste is the
minimum. An optional "Add over SSH" mode (Phase 4) gives true one-click for machines that
accept SSH.

## Decision: Yoal manages kernel WireGuard itself (hub and spoke)

We considered four options:

| Option | Verdict |
| --- | --- |
| **Yoal-managed kernel WireGuard, edge as hub** | **Chosen.** No third party. Keeps D4. The edge already has a public IP, so there is no NAT traversal to solve: each worker dials the edge with `PersistentKeepalive=25`. The root helper already exists to own privileged verbs. Kernel WireGuard is in every supported distro (≥ 5.6; on Ubuntu 24.04 and Debian 12/13 it is built in). |
| Tailscale / Headscale | Best NAT traversal and ACLs, but it adds a daemon on every node. Hosted Tailscale is non-commercial on the free tier and caps tagged devices. A machine can be on only one tailnet at a time, so a homelab already on a personal tailnet conflicts. `tsnet` is Go-only. We keep it only as **bring your own network** (see below). |
| NetBird / Nebula / ZeroTier / Netmaker | NetBird's server is AGPL and heavy (Compose + Traefik, 2 GB). Nebula needs certificate and revocation management. ZeroTier needs a two-sided join. Netmaker is heavy. None of them beats ~400 lines of our own code for a single hub. |
| VPN-less reverse tunnel (agent dials out over WSS, edge exposes a per-node unix socket) | The cleanest join, since it needs no UDP and no kernel module. But there is no maintained JS stream multiplexer (yamux and smux are Go), so we would own flow control, backpressure for 5 GB S3 PUTs, and TCP-over-TCP behaviour. The alternative is bundling a Go sidecar (chisel or frp). Kept as the **UDP-blocked fallback** (Phase 5), not the default. |

**Bring your own network** stays first-class. If the machine already shares a private network
with the edge (Tailscale, LAN, provider VPC), the operator picks "Existing private network" and
enters an address. That is today's `--public-address` path, renamed and validated.

### Proposed D98

> **Yoal provisions the node network itself.** The installer creates `wg0` on the edge (hub,
> UDP 51820) and allocates the overlay from a per-install random `/24` in `10.0.0.0/8`,
> checking that it does not collide with local routes. A joining worker generates its key pair
> locally and sends only the public key with the single-use join token. The control plane
> allocates the next `/32` and returns the edge's public key, endpoint and the worker's address.
> The edge's helper adds the peer live (`wg set`, no restart) from desired state. Every peer
> is also persisted to a helper-owned config file and restored at boot by
> `yoal-wireguard.service` (`ip link add … type wireguard` + `wg setconf`). The helper does not
> use `wg-quick` or systemd-networkd, so it never touches the host's existing network manager.
> The worker's Caddy listens only on its overlay address. Agent control traffic stays on public
> HTTPS with the node token, so the tunnel is data plane only and the `/etc/hosts` pin goes
> away. Operators who already have a private network can supply an address instead. Refines
> D4; supersedes "WireGuard itself is host provisioned".
>
> **Why:** Joining a worker drops from about 15 manual steps on two machines to one command on
> one. There is no third-party dependency or account, it is CGNAT-proof (the worker dials out),
> and the private key never leaves the node.
> **Rejected:** Tailscale/Headscale as the default (extra daemon, account, tailnet conflicts),
> NetBird (AGPL, heavy), Nebula (certificate lifecycle), a custom reverse-tunnel mux as the
> default (we would own a multiplexer), wg-quick or networkd (they disturb host networking).

Open question for review: should agent control traffic move onto the tunnel later? Public HTTPS
is already TLS plus a bearer token, and it avoids a chicken-and-egg problem at join time. The
DESIGN §"Agents pull over WireGuard" line would need editing.

## The flow (what the operator sees)

1. **Nodes → Add node.** A dialog asks for the name (default `homelab`) and the network:
   *Yoal network (recommended)* or *Existing private network*. It then shows:

   ```sh
   curl -fsSL https://control.example.com/install/node.sh | sudo sh -s -- \
     --token skn1_<ca-sha256>_<secret> --name homelab
   ```

   The dialog then switches to a live checklist backed by the node's join status:
   `○ Waiting for the machine… → ✓ Token used → ✓ Tunnel handshake → ✓ Agent online → ✓ Edge can reach node`.
   The checklist polls with TanStack Query and flips to green on the first heartbeat plus the
   edge probe.

2. **`node.sh`** is a small, readable POSIX script served by the control plane and generated
   per install, so the origin is baked in. It:
   - runs a preflight: root, systemd, `uname -m` → amd64/arm64, and the kernel WireGuard module
     (`ip link add yoalprobe type wireguard`). LXC without the module fails here with a clear
     message.
   - downloads `yoal-<version>-linux-<arch>.tar.gz` and the Caddy tarball from the control
     plane's own `/install/artifacts/…`. These are the same signed CI artifacts the self-updater
     uses, at the edge's exact version. The script verifies the SHA-256 from a manifest fetched
     over the pinned connection, and the agent then checks the release signature (`signing.ts`)
     before activating anything.
   - installs `wireguard-tools` with apt/dnf if `wg` is missing. This is the only package it
     installs; Caddy comes from the tarball, so no Cloudsmith repo is needed.
   - hands over to `yoal-agent install-node --token … --name …`. Everything else is TypeScript
     that we can test, not shell.

3. **`yoal-agent install-node`** (new subcommand):
   - verifies the control plane's TLS certificate against `<ca-sha256>` from the token, k3s
     `K10…` style, before sending anything. This stops a MITM on first contact even with a
     wrong system trust store.
   - creates users, directories, tmpfiles, `yoal.env` and the units (agent, helper, builder,
     storage, `yoal-caddy`). It does this by calling the **same generators the edge installer
     uses** (`scripts/systemd/*.ts`), not by keeping a second copy in a Svelte page.
   - asks the helper to generate the WireGuard key pair, so the private key goes straight to a
     0600 root file and is never in agent memory.
   - calls `/api/agent/join` with `{token, name, version, wireguard: {publicKey}}`. The response
     carries `{nodeId, nodeToken, wireguard: {address, edgePublicKey, edgeEndpoint, mtu}}`.
   - calls `helper wireguard apply` to bring `wg0` up, then waits for a handshake (up to 20 s).
     On timeout it prints a diagnosis: outbound UDP 51820 is probably blocked, so check the
     router or use bring-your-own-network.
   - sets `YOAL_CADDY_LISTEN=<overlay>:8080`, starts the services and exits 0. It is
     idempotent, so a re-run repairs a half-installed node.

4. **The edge** applies the new peer at its next reconcile. Desired state gains
   `wireguardPeers: [{nodeId, publicKey, address}]` for the edge node only. The edge agent calls
   `helper wireguard peers`, which diffs against the live peers and persists the result. The
   edge then probes `http://<overlay>:8080/` (an internal health host on the worker's Caddy) and
   reports `reachable` per worker, which feeds the checklist and the "Node offline" alert.

## Phases

### Phase 1 — Edge hub and data model (S)
- Migration: `nodes.wg_public_key`, `nodes.wg_address` (unique), `nodes.network_mode`
  (`yoal|external|edge`). Keep `public_address` as the proxy target and derive it from
  `wg_address` for `yoal` mode. Add a `settings` row for the overlay CIDR and the edge key.
- `apps/helper/src/wireguard.ts` with fixed verbs: `keygen` (returns the public key only),
  `apply` (interface + address + peers), `peers` (diff and set), `status` (latest handshakes).
  Validation is strict: base64 keys, `/32` inside the overlay, port, MTU from 1280 to 1420.
  Persist to `/etc/yoal/wireguard/wg0.conf` (wg `setconf` format, no wg-quick keys).
  `yoal-wireguard.service` restores the interface at boot, before `yoal-caddy`.
- Installer: on the edge, pick a free `/24`, keygen, apply, and open UDP 51820. Open it only
  when nftables/ufw is active, as a separate `table inet yoal` loaded with `nft -c` then
  `nft -f`. Allow on `wg0` only TCP to the overlay port; drop the rest. Existing hand-made
  `wg0`s are detected and left alone; that node runs in `external` mode.
- Tests: helper validation and diff unit tests, plus an e2e run in the OrbStack systemd
  harness with two containers (`--cap-add NET_ADMIN`, with the host module).

### Phase 2 — Join exchange and agent install (M)
- Contracts: `nodeJoinSchema.wireguard?`, a join response with a `wireguard` block, and the
  token format `skn1_<sha256(spki)>_<secret>`. Old tokens still work with system trust.
- `core.nodes.join` allocates an address in the same transaction that consumes the token, and
  bumps the edge's desired-state watermark.
- Edge reconcile of `wireguardPeers`, plus the edge reachability probe in heartbeats.
- `yoal-agent install-node`. Move the unit and env generation the `/nodes/vpn` page duplicates
  into `scripts/systemd` and reuse it from there.
- Node removal (`nodes.remove`) drops the peer and frees the address. Token rotation leaves the
  WireGuard key alone.

### Phase 3 — Served installer and dashboard (M)
- `GET /install/node.sh` (public, cacheable, origin baked in) and
  `GET /install/artifacts/:version/:file` (public; the artifacts are already public GitHub
  releases, and serving them from the edge pins the version and avoids GitHub rate limits).
  Fall back to a GitHub download when the edge has only a source build.
- An "Add node" dialog with a live checklist, replacing the join-token form on `/nodes`.
  Reduce `/nodes/vpn` to a "Troubleshooting & bring your own network" page with `wg show`
  output from `helper wireguard status`.
- Node detail page: overlay address, last handshake, bytes in/out, edge reachability, and a
  "Re-key" action, which runs keygen on the node, swaps the peer and removes the old key after
  the first new handshake.
- Docs: OPS §worker becomes a five-line section. Update DESIGN §network and ROADMAP, and add
  D98 to DECISIONS.

### Phase 4 — Optional "Add over SSH" (S–M, later)
- The operator enters `root@host` and pastes a one-time key, or uses an SSH agent from the CLI
  with `yoal nodes add root@host`. The control plane (or the CLI locally) runs the same
  `node.sh`. The CLI path is the safer default because no SSH key is stored on the control
  plane. If SSH keys are ever stored server-side, they are sealed with the org key like other
  secrets and deleted after a successful join.

### Phase 5 — UDP-blocked fallback (L, only if needed)
- Carry WireGuard over WSS on 443 through the edge's Caddy, wstunnel-style. Alternatively,
  bundle chisel/frp (MIT/Apache) as a sidecar with HTTP-only forwarding to a per-node unix
  socket. Automatic choice: when no handshake arrives within 20 s, retry over 443. Lower MTU
  (≈1280). Benchmark a 5 GB S3 PUT before shipping.

## Security notes
- The token is single-use, expires in an hour (as today) and pins the control plane's SPKI
  hash. `node.sh` is served only from the platform origin, and binaries are signature-checked
  by the agent before activation.
- The private key is generated by the helper on the node, stored 0600 root, and never sent
  anywhere. The edge stores only public keys.
- The edge's `wg0` input policy allows the overlay Caddy port only. The worker's Caddy binds
  only to its overlay address, so a worker cannot reach the edge's helper, SSH or control
  socket over the tunnel. Database and S3 gateways keep their existing loopback/host-route
  rules (D56, D82).
- Overlay CIDR collision check against `ip route` on both ends. A collision on the worker
  fails the join with a message, and the operator can pick another `/24` in settings.

## Acceptance
- On a fresh Debian 13 VM behind NAT (OrbStack or Proxmox), the pasted command brings the node
  to green in under 2 minutes, with nothing run on the edge.
- Rebooting either side restores the tunnel and serving with no operator action.
- Removing the node removes the peer from the live edge `wg show`.
- A re-run of the command on a joined node is a no-op repair.
- Hand-provisioned (`external`) workers keep working through the upgrade.

## Research summary (Haiku agents, 6 Nov 2026)
- **Kernel WG via `ip link` + `wg setconf`** is the portable choice. networkd is clean but
  disrupts hosts on ifupdown/NetworkManager. WireGuard has no TCP mode; `PersistentKeepalive=25`
  from the NATed side is enough with a public hub. Default MTU 1420, 1280 under nested tunnels.
  Avoid `100.64.0.0/10`, which collides with CGNAT and Tailscale.
- **Join UX prior art:** k3s (`curl | sh` with `K3S_URL`/`K3S_TOKEN`, a token carrying the CA
  hash), Komodo (onboarding key, then a node-generated key pair), Talos KubeSpan
  (node-generated WG keys, discovery shares public keys), Uncloud (WG mesh over SSH bootstrap),
  Portainer Edge (outbound-only).
- **Mesh products:** Tailscale is best for bring-your-own (OAuth-minted tagged auth keys, ACL
  `tag:edge → tag:worker:8080`), but one tailnet per device and non-commercial free tier.
  Headscale (BSD-3) is the self-hosted equivalent. NetBird is AGPL and heavy. Nebula needs CA
  and cert ops.
- **Reverse tunnels:** frp, rathole and chisel are permissive Go tools. Pangolin/Newt is AGPL.
  There is no JS yamux. TCP-over-TCP has head-of-line blocking, so a tunnel is the fallback,
  not the default.
