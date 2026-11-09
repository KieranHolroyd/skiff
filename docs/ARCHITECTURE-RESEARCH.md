# Architecture research: what open-source PaaS teach Yoal's internals

Status: **research note, 2026-11-08.** Phase A (flows) is built ([FLOWS.md](./FLOWS.md), D167).
Phases B–E are proposals; each becomes a D-number when it is built. For product features, see
[FEATURE-RESEARCH.md](./FEATURE-RESEARCH.md).

## Summary

Yoal's architecture is sound: pull-based agents, immutable releases, one service layer, and SQLite
replicated by Litestream. The research does not argue for Kubernetes, Raft or a new datastore. It
argues for finer-grained internals, because one feature at a time has added the same plumbing
everywhere:

| Measured in the tree (2026-11-08) | Effect |
|---|---|
| One global `state_version` (`settings`), bumped from 165 call sites | Any change wakes every node's long-poll and rebuilds every node's desired state |
| Desired state is one 46-field document per node, built by one ~400-line function | Each feature adds fields; the builder does per-deployment queries per pull |
| About 15 of those fields are one-shot command lists, each with a matching `*Results` field among the heartbeat's 40 | Commands and state share one contract and one version |
| About 30 `tick()` state machines in the maintenance sweep, plus 23 independent agent loops | Every feature reimplements leases, timeouts and terminal states |
| A managed service type touches about 8 layers (core, tables, desired state, agent loop, helper verb, MCP, REST, UI) | `databases.ts` is 3.7k lines; `mcp.ts` is 5.6k lines with about 179 tools |

## Sources

These are the projects we studied and the mechanisms we took from each. Research was run 2026-11-08
from primary sources where they were reachable. Unverified points are marked.

- **Cloud Foundry Diego.** Separate record types: `DesiredLRP` for intent, `ActualLRP` for each
  running instance (written by the cell that owns it), and `Task` for one-shot work with its own
  states (PENDING, RUNNING, COMPLETED, RESOLVING) and a completion callback. A converger corrects
  drift from a snapshot. Locket provides TTL locks and node presence.
  ([LRPs](https://github.com/cloudfoundry/bbs/blob/master/docs/030-lrps.md),
  [Tasks](https://github.com/cloudfoundry/bbs/blob/master/docs/020-tasks.md),
  [Locket](https://github.com/cloudfoundry/locket/blob/master/docs/010-locks-and-presences.md))
- **Cloud Foundry v3 API.** An async call returns `202` with a job resource whose states are
  `PROCESSING`, `POLLING`, `COMPLETE` and `FAILED`.
  ([v3 docs](https://v3-apidocs.cloudfoundry.org/version/3.200.0/index.html))
- **Kubernetes controllers.**
  ([API conventions](https://github.com/kubernetes/community/blob/master/contributors/devel/sig-architecture/api-conventions.md),
  [node authorization](https://kubernetes.io/docs/reference/access-authn-authz/node/))
  - Reconciliation is level-triggered.
  - Each object splits spec and status, with `generation`/`observedGeneration` and conditions.
  - Finalizers and owner references handle deletion.
  - `resourceVersion` supports list-then-watch, and a node sees only its own objects.
- **Fly.io.**
  - flyd logs each step of a state machine to a local store and resumes after a restart
    ([exit interview](https://fly.io/blog/the-exit-interview-jp/),
    [scheduler](https://fly.io/blog/carving-the-scheduler-out-of-our-orchestrator/)).
  - Corrosion's lesson: each worker is the only writer of its own state, and a single global state
    domain was the mistake ([Corrosion](https://fly.io/blog/corrosion/)).
  - Retry and cancel semantics in superfly/fsm are **unverified**: its README is nearly empty.
- **Nomad.** The pipeline is jobs, then evaluations queued in a broker, then scheduler workers,
  then a plan queue. Clients pull with blocking queries on an index. Batch work is separated from
  service work. A heartbeat TTL plus grace period decides when a node is gone, and a disconnected
  node is `unknown` rather than `lost`.
  ([scheduling](https://developer.hashicorp.com/nomad/docs/concepts/scheduling/scheduling),
  [blocking queries](https://developer.hashicorp.com/nomad/api-docs#blocking-queries),
  [disconnect](https://developer.hashicorp.com/nomad/docs/job-specification/disconnect).
  BSL since 2023; we take the design only.)
- **Coolify, Dokploy, CapRover, Dokku, Kamal.** Failures from SSH multiplexing (coolify
  [#10853](https://github.com/coollabsio/coolify/issues/10853),
  [#11130](https://github.com/coollabsio/coolify/issues/11130)); jobs stuck non-terminal
  ([#11383](https://github.com/coollabsio/coolify/issues/11383)); maintenance jobs flooding the
  deploy queue ([#11062](https://github.com/coollabsio/coolify/issues/11062)); builds on serving
  hosts ([#2110](https://github.com/coollabsio/coolify/issues/2110)). On the positive side: Dokku's
  plugin triggers ([architecture](https://dokku.com/docs/development/architecture/)) and Kamal's
  health-gated switchover with drain ([kamal-proxy](https://github.com/basecamp/kamal-proxy)).
- **Service extension.**
  - Open Service Broker: catalog, provision, bind, and `last_operation` polling
    ([spec](https://github.com/openservicebrokerapi/servicebroker/blob/master/spec.md)).
  - Heroku add-ons: the platform owns config-var injection
    ([partner API](https://devcenter.heroku.com/articles/add-on-partner-api)).
  - Crossplane composition functions add resource types without changes to core.
  - CloudNativePG: one resource owns backups, PITR, replicas and failover
    ([architecture](https://cloudnative-pg.io/docs/1.25/architecture/)).
  - Kubernetes Service Catalog was archived in 2022
    ([repo](https://github.com/kubernetes-retired/service-catalog)).
- **Incus/LXD and SQLite HA.**
  - Incus's API returns an operation id for any call longer than about a second, with
    `/wait`, cancel and an events feed
    ([REST API](https://sources.debian.org/src/incus/6.0.5-6/doc/rest-api.md)).
  - dqlite makes recovery after a lost quorum hard
    ([LXD recovery](https://canonical.com/lxd/docs/latest/howto/cluster_recover/)).
  - S3 supports conditional writes (`If-None-Match`/`If-Match`)
    ([AWS](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html)).
  - Leader election on S3 is done with a lock object per epoch
    ([Morling](https://morling.dev/blog/leader-election-with-s3-conditional-writes)).
  - LiteFS lost data when a node was promoted before it had caught up
    ([Fly community](https://community.fly.io/t/litefs-promote-true-can-cause-data-loss-when-scaling-horizontally-seeking-guidance/26767)).

## Roadmap

| Phase | Change | Source | Status |
|---|---|---|---|
| **A** | One durable step engine for multi-step changes, and one async-operation contract for REST, SSE and MCP | flyd, Nomad eval broker, Incus operations, CF v3 jobs, Coolify #11383 | **Built** (D167); database moves migrated |
| **B** | Commands leave desired state. The ~15 imperative lists and their `*Results` move onto one generalised node-task channel (claim, lease, result, idempotency key), with one task runner on the agent that dispatches by kind | Diego Task vs LRP; Nomad batch vs service | Proposal |
| **C** | Desired state per resource. Rows of (node, kind, key, spec, revision) replace the global version; the agent long-polls `?since=<revision>` and gets only its changes. The document endpoint stays, rebuilt from rows, during migration | k8s `resourceVersion` + node-scoped watch; Nomad blocking-query index | Proposal |
| **D** | Status per resource. `generation`/`observedGeneration` and conditions per resource replace most of the 40-field heartbeat; drift becomes visible per resource; each node is the only writer of its own status | k8s spec/status; Corrosion ownership | Proposal |
| **E** | A service-kind interface. One module per managed service: schema, lifecycle verbs returning flows, binding (credentials + endpoints, core-owned env injection), desired-state and task contributions, agent handler, optional capabilities (backup, replicas, failover). REST, MCP and forms generated from the schema. Pilot with brokers or email before databases | OSB, Heroku add-ons, Crossplane, CloudNativePG | Proposal |
| **F** | Agent controllers. A registry of per-kind reconcilers sharing a work queue with per-key backoff replaces the 23 loops (follows B and C) | k8s controller-runtime | Proposal |

**Order.** B and C are the next big reductions, and both can be done mechanically behind the
existing contract. E should wait until B gives it a place to contribute tasks. F follows B and C.

## HA plan: what the research adds

The research confirms the direction in [CLUSTERING.md](./CLUSTERING.md) §6: SQLite with Litestream,
an object-store lease and an epoch, with no Raft, dqlite, rqlite or LiteFS. It adds:

1. **Lease objects.** Write a lock object per epoch with `If-None-Match`; do not rewrite one shared
   object.
2. **Epoch fencing.** Agents reject any request carrying an epoch below the highest they have
   seen. The lease alone does not stop a paused process from writing.
3. **Promotion.** Never promote a standby before it has caught up to the replica.
4. **Disconnects.** Distinguish `unknown` (disconnected) from `lost` (Nomad's model) before
   re-placing work.
5. **Before building the lease:**
   - Verify R2's conditional-write support against the real endpoint. It was **unverified**: the
     documentation found was a mirror.
   - When standbys can promote, add the controller epoch to the flow lease claim
     ([FLOWS.md](./FLOWS.md) §9).

## What not to do

- Do not use SSH as a control channel, or push-style node operations.
- Do not put long maintenance jobs on the queue deploys use.
- Do not build on serving nodes (D47 roles).
- Do not add a consensus layer for one to five nodes.
- Do not rewrite without tests. Coolify v5's tracking issue says v4 had "few tests" and its updates
  broke features ([#5685](https://github.com/coollabsio/coolify/issues/5685)). Every phase above
  migrates one consumer at a time behind its existing tests, as phase A did.
