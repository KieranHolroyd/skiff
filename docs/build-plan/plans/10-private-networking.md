# 10 — Cross-node private networking

> **Superseded in part (2026-11-06):** [CLUSTERING.md](../../CLUSTERING.md) §4.3 replaces "inject
> the remote private IP" with loopback service endpoints on the consumer node (L4 + mTLS over the
> overlay), so a failover changes an upstream instead of an app's environment. Address allocation,
> the firewall verb and the acceptance criteria below still apply.

**Priority:** P1 · **Effort:** M–L · **Lane:** C · **Wave:** 2
**Depends on:** 03 TLS, 04 isolation, F1 contracts
**Blocks:** 12 preview data (multi-node), any multi-node stateful app
**Primary files:** `packages/contracts/src/agent.ts`, `packages/contracts/src/database.ts`,
`packages/core/src/nodes.ts`, `packages/core/src/databases.ts`, `apps/helper/src/units.ts`,
`docs/EDGE.md`

## Goal

Let an app on one node reach a private database or storage instance on another node over
WireGuard, with TLS and a firewall that never exposes the data port publicly.

## Non-goals

- A general service mesh, mTLS, or Kubernetes DNS.
- Moving a database between nodes.
- Public database exposure.
- Multi-region routing.

## Current state

- Private attachments are same-node only (D56): `DatabaseService.attach` rejects another node, and
  `resolveForConsumer` pins the project to the database's node.
- `nodes` has `public_address`; no private address.
- WireGuard is host-provisioned between edge and workers; Skiff uses it for edge → worker app
  proxying.
- The agent/helper render `skiff-workloads` with loopback-published database ports.

## Design

### Address allocation

- Add `nodes.private_address` (WireGuard IP, e.g. `10.88.0.0/16`) and `private_cidr`.
- Control plane allocates a free address on join; agent reports the observed address in the
  heartbeat; a mismatch marks the node `degraded`.
- `desiredState` includes the node's private address and the peer list (or the agent derives peers
  from desired state).
- Firewall: only the WireGuard interface may reach database/storage ports. The helper writes
  nftables/iptables rules (fixed verb) or the agent configures `ufw`? Prefer a fixed helper verb
  `network.allowPrivate(port, cidr)`; no generic firewall API.
- Never bind a database to `0.0.0.0`; bind to `127.0.0.1` and the WireGuard IP, or use a
  WireGuard-only publish. Podman `PublishPort` can bind to the WG IP.

### Attachment resolution

- `DatabaseService.resolveForConsumer`:
  - Same node: loopback/alias as today.
  - Different node: inject `private_address:<hostPort>` and require TLS.
  - If TLS is not enabled, refuse with "enable TLS or place on the same node".
- Storage:
  - Private instance on another node: use the public SigV4 endpoint if `public`, else private IP +
    port with TLS? RustFS TLS is optional; require the public endpoint or same-node for private.
  - Document the trade-off.
- Placement: keep same-node as the default; cross-node is explicit (`placement: <node>`) or
  automatic when the database is public. Do not silently move a project.

### DNS / discovery

- v1: inject a stable `host` value (`db-<id>.skiff.internal`?) resolved how? Without DNS, use the
  IP. To keep env stable, inject `db-<id>` as an alias on the consumer's network? Cross-node
  aliases do not resolve.
- v1.5: a tiny per-node DNS resolver (dnsmasq) with records for managed resources, or a CoreDNS
  service on the edge. Adds a daemon; only if demand justifies it.
- Start with `private_address` in env and a `*_HOST` that is the IP. Document that the IP is stable
  for the node's lifetime. Add DNS later without changing the env shape if possible.
- Add `serviceDiscovery: 'ip'|'dns'` to config; default `ip`.

### Security

- TLS required for cross-node Postgres; `sslmode=require` or `verify-full` with the node CA.
- Firewall default deny; allow only the WireGuard CIDR and the specific port.
- No public route for a database. A storage public route remains SigV4-only.
- Audit cross-node attachment creation and firewall changes.
- Rate-limit / connection limits at the pooler.

## Implementation order

1. Contract fields + `nodes.private_address` migration (contract PR).
2. Address allocation on join + heartbeat report + mismatch alert.
3. Firewall helper verb + tests (deny by default, allow WG CIDR).
4. `DatabaseService` cross-node resolution + TLS enforcement.
5. Storage cross-node rules (public endpoint only for private).
6. Dashboard topology: app → data path, encrypted/private badge.
7. DNS resolver (optional) behind a flag.

## Acceptance criteria

- [ ] A worker app connects to an edge database over the private address with TLS; the public IP has
      no open database port.
- [ ] A cross-node attachment without TLS is refused with an actionable error.
- [ ] The firewall drops a connection from a non-WG interface; a test asserts it.
- [ ] Same-node behavior is unchanged; existing attachments do not break.
- [ ] A node address change is detected and surfaced; attachments fail closed until fixed.
- [ ] The dashboard shows the path and encryption status for every attachment.

## Tests

- Unit: address allocation, resolution, TLS requirement, firewall rule rendering.
- Integration: two agents in a test network; connect; deny public; WireGuard CIDR.
- Real node: edge + worker WireGuard, Postgres on edge, app on worker, `psql` with TLS.
- Security: port scan from public interface; no plaintext; no cross-org route.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Firewall mistake exposes DB | Deny by default; fixed verb; test public scan; review |
| WireGuard MTU/latency | Document; default same-node; health check |
| Address drift | Heartbeat observed address; mismatch alert; fail closed |
| DNS becomes critical | Defer DNS; use stable IPs first |
| TLS cert trust | Node CA; `require` default; `verify-full` optional |

## Rollout

`SKIFF_FEATURE_CROSS_NODE_DATA` off by default. Same-node remains default. Enable for a two-node
test, then document the supported topology. Do not enable by default until the firewall test passes.

## Open questions

- Is a per-node DNS resolver worth the footprint? Defer until users ask.
- Should the control plane allocate addresses or the agent? Control plane for determinism.
- Do we need a private address for the edge itself? Yes, the edge is a node.

## File ownership

Own: `packages/contracts/src/agent.ts` (address fields), `packages/contracts/src/database.ts`
(resolution fields), `packages/core/src/nodes.ts`, `packages/core/src/databases.ts`,
`apps/helper/src/network.ts` (new), `docs/EDGE.md`.

Integration-owned: schema/migration, helper server/systemd, agent main, Caddy route renderer,
dashboard layout, MCP/CLI registration, e2e harness.
