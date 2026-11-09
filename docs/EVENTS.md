# Yoal — Event notifications

Status: **implemented, 2026-11-07**. Covered by unit tests in core, agent and CLI. The RustFS
webhook target was spiked on the pinned 1.0.4 build (§5), but the whole chain
(RustFS → control plane → broker → function) has not yet run on a real node. The decision is
D122 in [DECISIONS.md](./DECISIONS.md).

An **event rule** publishes platform events into a queue, and a function consumes that queue.
This is Cloudflare's model, as in `wrangler r2 bucket notification create --queue`: the rule
belongs to the source and targets a queue, the function is an ordinary queue consumer, and it
handles each event in `queue()`. Yoal never calls a function directly for an event, so delivery
gets the queue's batching, `ack()`/`retry()`, retry delays and dead-letter queue
([FUNCTIONS.md §4.10](./FUNCTIONS.md), [BROKERS.md §6](./BROKERS.md)).

Everything goes through `packages/core` (`EventService`). REST, MCP, the CLI and the dashboard are
thin surfaces.

---

## 1. Sources and events

| Source | Events | Filter | Body |
|---|---|---|---|
| `storage` | `object-create`, `object-delete` | instance + bucket (required), key `prefix`, `suffix` | Cloudflare's R2 notification body (§3) |
| `alerts` | `firing`, `resolved` | one alert rule (default: every rule) | envelope; `data` is what the notifiers get |
| `deployments` | `created`, `promoted`, `failed` | one project (default: every project) | envelope |
| `database-backups` | `completed`, `failed` | one database (default: every database) | envelope |

A rule with no `events` matches every event of its source.

- **alerts**: emitted once per rule notification, the same message the notifiers send (grouped,
  repeats on `repeatMinutes`, resolved only with `notifyOnResolve`). Silences mute the
  notification, so they mute the event too.
- **deployments**: `created` for every new deployment (`data.production` says whether it went
  live), `promoted` for a promote or a production rollback (`data.rollback`), and `failed` for a
  failed git build (no deployment exists then, so `data` carries `buildId`, `ref` and `error`).
- **database-backups**: when the node reports a scheduled or manual dump.

## 2. Model

| Table | Purpose |
|---|---|
| `event_rules` | Org, source, events, filter (names **and** resolved ids, so a rename never re-targets a rule), broker id, queue, description, enabled. |
| `event_deliveries` | The outbox: one row per (event, rule) with the message body, `pending → delivered \| failed`, attempts, next attempt, lease, last error. |

- Ids are `evr_…` (rules), `evd_…` (deliveries) and `evt_…` (envelope events).
- At most 200 rules and 50 000 pending deliveries per org. A full outbox drops new events with a
  control-plane log line instead of growing without bound.
- Delivered and failed rows are kept for 7 days.
- **Permissions:** reading rules and deliveries needs `broker:read`. Creating, changing, testing or
  deleting a rule needs `broker:update` (it publishes into the broker), and creating one also needs
  read access to the source: `storage:read`, `metrics:read` (alerts), `deployment:read` or
  `database:read`.

## 3. Message bodies

A storage event uses R2's body, so a Worker written for R2 event notifications runs unchanged.
`yoal` carries the fields R2 has no place for:

```json
{
  "account": "org_…",
  "action": "PutObject",
  "bucket": "uploads",
  "object": { "key": "incoming/cat.jpg", "size": 48213, "eTag": "82d23a75…" },
  "eventTime": "2026-11-07T11:04:18.532Z",
  "yoal": { "type": "storage.object-create", "storage": "media", "eventName": "s3:ObjectCreated:Put" }
}
```

`action` is `PutObject` (put or POST upload), `CopyObject`, `CompleteMultipartUpload` or
`DeleteObject` (a delete, or a delete marker on a versioned bucket). Tagging, retention and
legal-hold changes are not events. Deletes carry no `size`.

Every other source uses one envelope:

```json
{ "type": "alerts.firing", "id": "evt_…", "time": "2026-11-07T11:20:00.000Z", "account": "org_…", "data": { … } }
```

Messages are published with `Yoal-Content-Type: json`, so the consumer gets `message.body` as an
object. `Nats-Msg-Id` is the delivery id, so JetStream drops a re-published duplicate.

## 4. Delivery

```
 source ──emit──▶ control plane: match rules ──▶ event_deliveries (pending)
                                                        │  POST /api/agent/events/lease
                                                        ▼
                         broker's node agent ──publish──▶ yoal.q.<queue> (JetStream)
                                │  POST /api/agent/events/ack        │
                                ▼                                    ▼
                         delivered / retry later           function queue() (D112)
```

1. **Emit.** A source calls `core.events.emit*` after its own work is done. Matching is
   in-process and an emit never throws into its caller, so a broken rule can't fail a deploy, a
   backup or an alert.
2. **Publish.** Only the broker's node can reach the broker (loopback port), so the agent on each
   node that runs brokers leases pending deliveries for them (`EventPublisher`). It polls every 2 s
   when idle and at once while a backlog remains. It publishes each delivery with the broker's
   owner credentials from its activation, then acks. A lease lasts 60 s.
3. **Retry.** A failed publish (broker down, store full) backs off 1 s, 2 s, 4 s … up to 5 min. A
   delivery still pending after 24 hours is marked `failed`. A rule whose broker was deleted stops
   being leased, and its deliveries fail when they expire.
4. **Consume.** From here it is an ordinary queue (BROKERS §6). Delivery is at least once end to
   end, so a consumer that must not act twice should key on `yoal.eventName`/`object.eTag`
   (storage) or `id` (envelope).

## 5. Storage events (RustFS)

RustFS sends bucket events through a webhook target, and the spike on 1.0.4 decided the shape:

- **The target is the control plane's public URL**, `POST /api/webhooks/storage/<instance id>`.
  RustFS refuses webhooks to private addresses (`outbound URL host … is not allowed: private
  address`), so a node-local listener is not an option. The instance's container already reaches
  the control plane over HTTPS.
- **Env, only while a rule watches a bucket on the instance:** `RUSTFS_NOTIFY_ENABLE=true`,
  `RUSTFS_NOTIFY_WEBHOOK_ENABLE_YOAL=on`, `…_ENDPOINT_YOAL`, `…_QUEUE_DIR_YOAL=/data/.yoal-notify`
  (desired state) and `…_AUTH_TOKEN_YOAL` (activation, a secret). Changing whether it is on changes
  the activation version, so **the instance restarts once** when its first rule is created and
  after its last rule goes. Instances without rules never restart for this.
- **The token** is `HMAC(master key, "storage-events:<id>")`. It is derived, so nothing is stored or
  rotated per instance. The webhook gives the same 401 for an unknown instance and a wrong token.
- **Bucket config.** A watched bucket's desired state has `notifications: true`, and the agent
  `PUT ?notification` to send every `s3:ObjectCreated:*` and `s3:ObjectRemoved:*` event to
  `arn:rustfs:sqs:us-east-1:yoal:webhook`. The ARN needs the lower-case target id and the region.
  Unwatched buckets get an empty config, and the agent re-asserts it on its 15-minute pass. The
  control plane, not RustFS, filters by event, prefix and suffix, so editing a rule never touches
  the bucket.
- **Durability.** RustFS keeps undelivered events in its queue dir on the data disk and retries.
  So an event isn't lost while the control plane restarts or is unreachable; it arrives late.
  Keys arrive URL-encoded and are decoded before matching.

## 6. Surfaces

- **Dashboard:** no page of its own. An event rule is shown as an **event trigger** in the
  **Triggers** card on the function's **Bindings & triggers** tab, next to its HTTP, cron and queue
  triggers (behind `YOAL_FEATURE_BROKERS`). The card lists the rules that publish into the
  function's consumer queues, plus rules on a broker attached to it whose queue no function
  consumes yet (flagged "queue not consumed", so a trigger set up before the consumer is deployed
  stays visible). Each one shows its source, events, filter, target queue and 24-hour counts with
  the last error. A row menu sends a test event, pauses or resumes it, or removes it. **Recent event
  deliveries** at the foot of the card shows the newest 25 for those rules with each message body.
  **Add trigger** changes its fields with the source (instance, bucket and key filters for storage;
  project, database or alert rule otherwise) and targets one of the function's consumer queues, or
  a new queue on an attached broker together with the `wrangler.jsonc` consumer line to copy. Every
  check still lives in `core.events`; the console only refuses to act on a rule that doesn't
  deliver to the function it is open on.
- **REST:** see [API.md](./API.md#event-notifications).
- **MCP and the assistant:** `list_event_rules`, `get_event_rule` (with its 20 newest deliveries),
  `create_event_rule` (returns next steps for wiring the consumer), `update_event_rule`,
  `test_event_rule`, `list_event_deliveries`, and `delete_event_rule` (asks for confirmation).
- **CLI:** `yoal events list|create|info|update|delete|test|deliveries` (alias `yoal event`).
- **Agent protocol:** `POST /api/agent/events/lease`, `POST /api/agent/events/ack`.
- **Webhook:** `POST /api/webhooks/storage/:id` (RustFS only, bearer token, 256 KiB cap).

Example: resize every JPEG uploaded under `incoming/`.

```sh
yoal broker attach jobs --project resizer
yoal events create storage --storage media --bucket uploads --prefix incoming/ --suffix .jpg \
  --event object-create --broker jobs --queue images
```

```jsonc
// resizer/wrangler.jsonc
{ "queues": { "consumers": [{ "queue": "images", "max_batch_size": 10, "dead_letter_queue": "images-dlq" }] } }
```

```js
export default {
  async queue(batch, env) {
    for (const message of batch.messages) {
      const { bucket, object } = message.body; // R2's notification shape
      await resize(env, bucket, object.key);
      message.ack();
    }
  },
};
```

## 7. Not yet

- Editing a rule's events or key filters in the dashboard (the API, MCP and CLI can; the
  function console only pauses, resumes, tests and removes).
- More sources: function errors, node health, certificate renewals, storage replication lag.
- Queues on a broker in another org, and cross-node brokers (BROKERS §7, C2).
- An end-to-end run on a real node: RustFS → webhook → outbox → NATS → workerd.
