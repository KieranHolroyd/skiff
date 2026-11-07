import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * Skiff platform schema (SQLite; DESIGN §6.2, D9, D17). Better Auth owns the `user`,
 * `session`, `organization`, `member`, `apikey` and related tables; this file owns everything
 * Skiff adds. User/org ids are stored as text without declared foreign keys so the two
 * migration streams stay independent; `migrations/0001_init.sql` adds the real constraints.
 *
 * Timestamps are epoch milliseconds (integer) — SQLite has no date type and this keeps
 * ordering and arithmetic cheap.
 */

const now = () => Date.now();

export const nodes = sqliteTable(
	'nodes',
	{
		id: text('id').primaryKey(),
		name: text('name').notNull(),
		/** `edge` terminates ingress; `worker` is a named placement target. */
		mode: text('mode', { enum: ['edge', 'worker'] }).notNull().default('worker'),
		status: text('status', { enum: ['pending', 'online', 'offline', 'draining'] })
			.notNull()
			.default('pending'),
		publicAddress: text('public_address'),
		version: text('version'),
		agentVersion: text('agent_version'),
		tokenHash: text('token_hash').notNull(),
		desiredStateVersion: integer('desired_state_version').notNull().default(1),
		lastHeartbeatAt: integer('last_heartbeat_at'),
		statsJson: text('stats_json'),
		/** Memory budget for `skiff-workloads.slice` on this node (DESIGN §3.4.1). */
		sliceMemoryMb: integer('slice_memory_mb').notNull().default(1024),
		/** CPU weight for the workload slice; lower than skiff-cp/agent/caddy so apps yield first. */
		sliceCpuWeight: integer('slice_cpu_weight').notNull().default(200),
		/** This node is allowed to claim git build jobs (D3: the homelab Builder). */
		canBuild: integer('can_build', { mode: 'boolean' }).notNull().default(false),
		/** Failure domain: nodes in one zone share power, uplink and provider fate (CLUSTERING §3.2). */
		zone: text('zone').notNull().default('default'),
		/** Operator-set roles; NULL keeps the derivation from mode/can_build for older rows. */
		rolesJson: text('roles_json'),
		/** Operator labels for placement constraints (`owner=media`); never `skiff.io/*`. */
		labelsJson: text('labels_json'),
		/** Last hardware fact block (`NodeHardware`, CLUSTERING §3.1). */
		hardwareJson: text('hardware_json'),
		hardwareAt: integer('hardware_at'),
		/** Last parse/collection failure, surfaced on the node page; null when healthy. */
		hardwareError: text('hardware_error'),
		/** LAN address for direct peering inside one zone (C1). */
		lanEndpoint: text('lan_endpoint'),
		/** CPU reservation budget in millis; null means no explicit cap (CLUSTERING §3.4). */
		cpuBudgetMillis: integer('cpu_budget_millis'),
		/** Managed overlay address (C1); null on external and pre-C1 nodes. */
		privateAddress: text('private_address'),
		privateCidr: text('private_cidr'),
		/** The node's WireGuard public key; the private key never leaves the node. */
		wgPublicKey: text('wg_public_key'),
		/** `skiff` managed, `external` host-provisioned/BYO, `edge` legacy edge interface. */
		networkMode: text('network_mode', { enum: ['skiff', 'external', 'edge'] }).notNull().default('external'),
		wgEndpoint: text('wg_endpoint'),
		wgListenPort: integer('wg_listen_port'),
		/** Last `wg show` peer health reported by the agent (public data only). */
		wgStatusJson: text('wg_status_json'),
		wgStatusAt: integer('wg_status_at'),
		/** Requested agent data/release-cache directory; null keeps the install default (D48). */
		storageDataDir: text('storage_data_dir'),
		/** Requested Builder scratch directory; null keeps the install default (D48). */
		storageBuildDir: text('storage_build_dir'),
		/** Last report from the node's skiff-storage.service (`NodeStorageStatus`). */
		storageStatusJson: text('storage_status_json'),
		/** Volume new managed instances use when they name none (D74). */
		defaultVolumeId: text('default_volume_id'),
		/** Latest raw volume inventory (`VolumeInventory`), for the adopt/provision wizard. */
		volumeInventoryJson: text('volume_inventory_json'),
		/** Capabilities from the last heartbeat (JSON array); `[]` for agents that predate them. */
		capabilitiesJson: text('capabilities_json'),
		/** Outstanding dashboard update target (D99); NULL when none is pending. */
		updateVersion: text('update_version'),
		/** Bumped on every update request, so a retry is a new task. */
		updateGeneration: integer('update_generation').notNull().default(0),
		updateRequestedAt: integer('update_requested_at'),
		/** The generation the agent reported as failed; equal to `updateGeneration` means failed. */
		updateFailedGeneration: integer('update_failed_generation').notNull().default(0),
		updateError: text('update_error'),
		createdAt: integer('created_at').notNull().$defaultFn(now),
		updatedAt: integer('updated_at').notNull().$defaultFn(now),
	},
	(t) => [index('nodes_status_idx').on(t.status)],
);

/** Public node certificates issued by the per-install CA (C2); private keys stay on the node. */
export const nodeCertificates = sqliteTable('node_certificates', {
	nodeId: text('node_id').primaryKey(),
	serial: text('serial').notNull(),
	certPem: text('cert_pem').notNull(),
	caSerial: text('ca_serial'),
	issuedAt: integer('issued_at').notNull(),
	expiresAt: integer('expires_at').notNull(),
	revokedAt: integer('revoked_at'),
});

/** A consumer-side loopback port for one remote database or storage instance (C2). */
export const serviceEndpoints = sqliteTable(
	'service_endpoints',
	{
		id: text('id').primaryKey(),
		consumerNodeId: text('consumer_node_id').notNull(),
		serviceKind: text('service_kind', { enum: ['database', 'storage'] }).notNull(),
		serviceId: text('service_id').notNull(),
		localPort: integer('local_port').notNull(),
		upstreamNodeId: text('upstream_node_id').notNull(),
		upstreamPort: integer('upstream_port').notNull(),
		createdAt: integer('created_at').notNull().$defaultFn(now),
		updatedAt: integer('updated_at').notNull().$defaultFn(now),
	},
	(t) => [
		uniqueIndex('service_endpoints_consumer_port_idx').on(t.consumerNodeId, t.localPort),
		uniqueIndex('service_endpoints_pair_idx').on(t.consumerNodeId, t.serviceKind, t.serviceId),
		index('service_endpoints_upstream_idx').on(t.upstreamNodeId),
	],
);

/** Platform-level network filesystem definitions (C3); credentials are an opaque reference. */
export const shares = sqliteTable(
	'shares',
	{
		id: text('id').primaryKey(),
		name: text('name').notNull(),
		protocol: text('protocol', { enum: ['nfs', 'smb'] }).notNull(),
		server: text('server').notNull(),
		exportPath: text('export_path').notNull(),
		zone: text('zone').notNull().default('default'),
		readOnly: integer('read_only', { mode: 'boolean' }).notNull().default(true),
		credentialsRef: text('credentials_ref'),
		createdBy: text('created_by').notNull(),
		createdAt: integer('created_at').notNull().$defaultFn(now),
		updatedAt: integer('updated_at').notNull().$defaultFn(now),
	},
	(t) => [uniqueIndex('shares_name_idx').on(t.name)],
);

export const shareGrants = sqliteTable(
	'share_grants',
	{
		shareId: text('share_id').notNull(),
		orgId: text('org_id').notNull(),
		mode: text('mode', { enum: ['ro', 'rw'] }).notNull().default('ro'),
		pathPrefix: text('path_prefix').notNull().default(''),
		createdAt: integer('created_at').notNull().$defaultFn(now),
	},
	(t) => [primaryKey({ columns: [t.shareId, t.orgId] }), index('share_grants_org_idx').on(t.orgId)],
);

/** One spread copy of a workload (C4); the base workload keeps its single-node expansion. */
export const workloadReplicas = sqliteTable(
	'workload_replicas',
	{
		id: text('id').primaryKey(),
		workloadId: text('workload_id').notNull(),
		projectId: text('project_id').notNull(),
		nodeId: text('node_id').notNull(),
		replicaIndex: integer('replica_index').notNull(),
		status: text('status', { enum: ['pending', 'starting', 'running', 'failed', 'stopped'] })
			.notNull()
			.default('pending'),
		placementReason: text('placement_reason'),
		createdAt: integer('created_at').notNull().$defaultFn(now),
		updatedAt: integer('updated_at').notNull().$defaultFn(now),
	},
	(t) => [
		uniqueIndex('workload_replicas_index_idx').on(t.workloadId, t.replicaIndex),
		index('workload_replicas_node_idx').on(t.nodeId),
		index('workload_replicas_project_idx').on(t.projectId),
	],
);

/** Managed database replicas (C7); the `databases` row remains the primary. */
export const databaseReplicas = sqliteTable(
	'database_replicas',
	{
		id: text('id').primaryKey(),
		databaseId: text('database_id').notNull(),
		nodeId: text('node_id').notNull(),
		status: text('status', { enum: ['pending', 'streaming', 'lagging', 'lost', 'failed', 'stopped'] })
			.notNull()
			.default('pending'),
		replayLsn: text('replay_lsn'),
		lagBytes: integer('lag_bytes'),
		lagSeconds: real('lag_seconds'),
		slot: text('slot'),
		primaryGeneration: integer('primary_generation').notNull().default(0),
		/** Loopback port the replica publishes on its node (0069). */
		hostPort: integer('host_port'),
		volumeId: text('volume_id'),
		mode: text('mode', { enum: ['async', 'sync'] }).notNull().default('async'),
		/** Last problem the primary or the replica node reported. */
		message: text('message'),
		sentLsn: text('sent_lsn'),
		/** When the primary last reported this replica's slot. */
		reportedAt: integer('reported_at'),
		/** Delete requested: the replica stops, its node purges the data dir, the primary drops the slot. */
		removingAt: integer('removing_at'),
		/** The replica's node confirmed the data dir is gone. */
		purgedAt: integer('purged_at'),
		/** Re-add a fresh replica on the same node once this one is purged (after a promotion). */
		rebuildOnPurge: integer('rebuild_on_purge', { mode: 'boolean' }).notNull().default(false),
		createdAt: integer('created_at').notNull().$defaultFn(now),
		updatedAt: integer('updated_at').notNull().$defaultFn(now),
	},
	(t) => [
		uniqueIndex('database_replicas_pair_idx').on(t.databaseId, t.nodeId),
		index('database_replicas_node_idx').on(t.nodeId),
	],
);

/** Failover attempts (C7/C8); append-only history with measured outcome. */
export const databaseFailovers = sqliteTable(
	'database_failovers',
	{
		id: text('id').primaryKey(),
		databaseId: text('database_id').notNull(),
		fromNodeId: text('from_node_id'),
		toNodeId: text('to_node_id').notNull(),
		generation: integer('generation').notNull(),
		status: text('status', { enum: ['pending', 'promoting', 'completed', 'failed', 'rolled-back'] })
			.notNull()
			.default('pending'),
		reason: text('reason'),
		startedAt: integer('started_at').notNull(),
		finishedAt: integer('finished_at'),
		/** The replica being promoted (0069). */
		replicaId: text('replica_id'),
		/** State version the fence was issued at; the old node confirms at or after it. */
		fenceVersion: integer('fence_version'),
		fencedAt: integer('fenced_at'),
		promotedAt: integer('promoted_at'),
		/** The old primary's data dir was deleted on its node. */
		oldPurgedAt: integer('old_purged_at'),
		/** The promoted replica's leftover directory was deleted. */
		replicaPurgedAt: integer('replica_purged_at'),
		message: text('message'),
	},
	(t) => [
		index('database_failovers_database_idx').on(t.databaseId, t.startedAt),
		index('database_failovers_status_idx').on(t.status),
	],
);

/** Replication role password and apply state per primary (C7, 0069). */
export const databaseReplication = sqliteTable('database_replication', {
	databaseId: text('database_id').primaryKey(),
	secretSealed: text('secret_sealed').notNull(),
	appliedVersion: text('applied_version'),
	appliedAt: integer('applied_at'),
	error: text('error'),
	createdAt: integer('created_at').notNull().$defaultFn(now),
	updatedAt: integer('updated_at').notNull().$defaultFn(now),
});

/** Failover controller history (C8, migration 0060); see `@skiff/contracts` FailoverEventView. */
export const failoverEvents = sqliteTable(
	'failover_events',
	{
		id: text('id').primaryKey(),
		kind: text('kind', { enum: ['replica', 'ingress', 'database', 'lease'] }).notNull(),
		status: text('status', {
			enum: ['queued', 'in-progress', 'completed', 'failed', 'blocked', 'expired', 'cancelled', 'manual'],
		}).notNull(),
		stage: text('stage', { enum: ['detect', 'decide', 'fence', 'promote', 'repoint', 'heal', 'complete'] })
			.notNull()
			.default('detect'),
		subjectId: text('subject_id').notNull(),
		subjectName: text('subject_name'),
		orgId: text('org_id'),
		fromNodeId: text('from_node_id'),
		toNodeId: text('to_node_id'),
		reason: text('reason').notNull().default(''),
		epoch: integer('epoch').notNull().default(0),
		/** Database failovers: the primary generation the promotion moves to. */
		generation: integer('generation'),
		detectedAt: integer('detected_at').notNull(),
		/** When the controller wrote the change; rate limits and the completion timeout count from it. */
		appliedAt: integer('applied_at'),
		updatedAt: integer('updated_at').notNull(),
		finishedAt: integer('finished_at'),
	},
	(t) => [
		index('failover_events_status_idx').on(t.status, t.updatedAt),
		index('failover_events_subject_idx').on(t.kind, t.subjectId, t.fromNodeId),
		index('failover_events_detected_idx').on(t.detectedAt),
	],
);

/** Bucket replication from a source storage instance to a passive target (C9). */
export const storageReplication = sqliteTable(
	'storage_replication',
	{
		id: text('id').primaryKey(),
		sourceId: text('source_id').notNull(),
		targetId: text('target_id').notNull(),
		mode: text('mode', { enum: ['bucket'] }).notNull().default('bucket'),
		status: text('status', {
			enum: ['pending', 'linking', 'syncing', 'protected', 'lagging', 'failed', 'stopped'],
		})
			.notNull()
			.default('pending'),
		lastSyncAt: integer('last_sync_at'),
		lagSeconds: real('lag_seconds'),
		/** Scoped key the runner uses on the peer instance (0059); the secret is sealed. */
		accessKeyId: text('access_key_id'),
		secretSealed: text('secret_sealed'),
		lastError: text('last_error'),
		lastAttemptAt: integer('last_attempt_at'),
		/** First pass that finished with nothing pending; RPO is unbounded before it. */
		initialSyncAt: integer('initial_sync_at'),
		pendingObjects: integer('pending_objects'),
		objectsCopied: integer('objects_copied').notNull().default(0),
		bytesCopied: integer('bytes_copied').notNull().default(0),
		/** Latest per-bucket report from the runner. */
		bucketsJson: text('buckets_json'),
		createdAt: integer('created_at').notNull().$defaultFn(now),
		updatedAt: integer('updated_at').notNull().$defaultFn(now),
	},
	(t) => [
		uniqueIndex('storage_replication_pair_idx').on(t.sourceId, t.targetId),
		index('storage_replication_target_idx').on(t.targetId),
	],
);

export const nodeJoinTokens = sqliteTable(
	'node_join_tokens',
	{
		id: text('id').primaryKey(),
		tokenHash: text('token_hash').notNull(),
		nodeName: text('node_name'),
		createdBy: text('created_by').notNull(),
		expiresAt: integer('expires_at').notNull(),
		usedAt: integer('used_at'),
		usedByNodeId: text('used_by_node_id'),
		createdAt: integer('created_at').notNull().$defaultFn(now),
	},
	(t) => [uniqueIndex('node_join_tokens_hash_idx').on(t.tokenHash)],
);

/**
 * A mounted filesystem a node can place managed workloads on (docs/VOLUMES.md, D72). `source_key`
 * is the stable node-reported identity (filesystem UUID, `zfs:pool/dataset`, `nfs:host:/export`);
 * `stack_json` records how a provisioned volume was built. Names are unique per node.
 */
export const nodeVolumes = sqliteTable(
	'node_volumes',
	{
		id: text('id').primaryKey(),
		nodeId: text('node_id').notNull(),
		name: text('name').notNull(),
		kind: text('kind', { enum: ['filesystem', 'lvm', 'mdadm', 'zfs', 'luks', 'nfs', 'cifs'] })
			.notNull()
			.default('filesystem'),
		sourceKey: text('source_key').notNull(),
		mountPath: text('mount_path').notNull(),
		fsType: text('fs_type').notNull(),
		/** Comma-separated mount options as last observed; display and re-mount hints only. */
		options: text('options').notNull().default(''),
		remote: integer('remote', { mode: 'boolean' }).notNull().default(false),
		/** Derived volume class (CLUSTERING §3.3): fast, bulk, remote or unknown. */
		class: text('class', { enum: ['fast', 'bulk', 'remote', 'unknown'] }).notNull().default('unknown'),
		/** Operator override; `class` stays the derived value for drift detection. */
		classOverride: text('class_override', { enum: ['fast', 'bulk', 'remote'] }),
		classOverrideReason: text('class_override_reason'),
		/** Provisioning plan/steps (`VolumeStack`); null for an adopted mount. */
		stackJson: text('stack_json'),
		status: text('status', { enum: ['pending', 'ready', 'missing', 'failed', 'removing'] })
			.notNull()
			.default('pending'),
		message: text('message'),
		sizeBytes: integer('size_bytes'),
		freeBytes: integer('free_bytes'),
		statsAt: integer('stats_at'),
		createdBy: text('created_by').notNull(),
		createdAt: integer('created_at').notNull().$defaultFn(now),
		updatedAt: integer('updated_at').notNull().$defaultFn(now),
	},
	(t) => [
		uniqueIndex('node_volumes_node_name_idx').on(t.nodeId, t.name),
		uniqueIndex('node_volumes_node_source_idx').on(t.nodeId, t.sourceKey),
		index('node_volumes_node_idx').on(t.nodeId),
	],
);

/**
 * Project-owned application volumes (plan 07, docs/VOLUMES.md). Distinct from `node_volumes`:
 * an app volume is the user-facing resource a workload mounts, backed by a node volume or the
 * helper's state directory. The host path is derived on the node and never stored here.
 */
export const appVolumes = sqliteTable(
	'app_volumes',
	{
		id: text('id').primaryKey(),
		orgId: text('org_id').notNull(),
		projectId: text('project_id').notNull(),
		name: text('name').notNull(),
		nodeId: text('node_id').notNull(),
		backing: text('backing', { enum: ['node_volume', 'state_dir'] }).notNull().default('state_dir'),
		nodeVolumeId: text('node_volume_id'),
		/** Quota and disk-admission input. */
		sizeMb: integer('size_mb').notNull(),
		/** Latest helper usage sample; null until the node reports one. */
		usedBytes: integer('used_bytes'),
		/** When the node measured `usedBytes` (epoch ms). */
		usedAt: integer('used_at'),
		/** Last attached mount path, for display; attachments carry the authoritative value. */
		mountPath: text('mount_path').notNull().default(''),
		status: text('status', { enum: ['pending', 'ready', 'missing', 'failed', 'deleting'] })
			.notNull()
			.default('pending'),
		message: text('message'),
		singleWriter: integer('single_writer', { mode: 'boolean' }).notNull().default(true),
		createdBy: text('created_by').notNull(),
		createdAt: integer('created_at').notNull().$defaultFn(now),
		updatedAt: integer('updated_at').notNull().$defaultFn(now),
		deletedAt: integer('deleted_at'),
		/** Soft-deleted volumes keep their data until this point (seven days). */
		purgeAt: integer('purge_at'),
		/** Set once the trash window is over: the node deletes the directory, then the row goes. */
		purgeRequestedAt: integer('purge_requested_at'),
		/** Snapshot being restored into this (new) volume; null once the restore settled. */
		restoreSnapshotId: text('restore_snapshot_id'),
	},
	(t) => [
		uniqueIndex('app_volumes_project_name_idx').on(t.projectId, t.name),
		index('app_volumes_project_idx').on(t.projectId),
		index('app_volumes_node_idx').on(t.nodeId),
		index('app_volumes_deleted_idx').on(t.deletedAt),
	],
);

export const appVolumeAttachments = sqliteTable(
	'app_volume_attachments',
	{
		id: text('id').primaryKey(),
		orgId: text('org_id').notNull(),
		projectId: text('project_id').notNull(),
		volumeId: text('volume_id').notNull(),
		workloadId: text('workload_id').notNull(),
		environment: text('environment').notNull().default('production'),
		mountPath: text('mount_path').notNull(),
		readOnly: integer('read_only', { mode: 'boolean' }).notNull().default(false),
		createdAt: integer('created_at').notNull().$defaultFn(now),
	},
	(t) => [
		uniqueIndex('app_volume_attachments_volume_idx').on(t.volumeId, t.workloadId, t.environment),
		uniqueIndex('app_volume_attachments_mount_idx').on(t.workloadId, t.environment, t.mountPath),
		index('app_volume_attachments_project_idx').on(t.projectId),
		index('app_volume_attachments_workload_idx').on(t.workloadId),
	],
);

export const appVolumeSnapshots = sqliteTable(
	'app_volume_snapshots',
	{
		id: text('id').primaryKey(),
		orgId: text('org_id').notNull(),
		volumeId: text('volume_id').notNull(),
		/** Backup target (plan 05); null while queued or after the target was removed. */
		targetId: text('target_id'),
		objectKey: text('object_key').notNull(),
		sizeBytes: integer('size_bytes'),
		checksum: text('checksum'),
		pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
		status: text('status', { enum: ['pending', 'running', 'ok', 'failed'] })
			.notNull()
			.default('pending'),
		error: text('error'),
		createdAt: integer('created_at').notNull().$defaultFn(now),
		expiresAt: integer('expires_at'),
		restoreVerifiedAt: integer('restore_verified_at'),
		label: text('label'),
		/** How the node made the copy: `reflink`, `paused`, `idle` or `live`; null until it ran. */
		method: text('method'),
		/** Whether the writer was paused for a consistent copy. */
		quiesce: integer('quiesce', { mode: 'boolean' }).notNull().default(true),
		createdBy: text('created_by'),
		finishedAt: integer('finished_at'),
		/** Name of the target when the snapshot was queued, kept after the target is deleted. */
		targetName: text('target_name'),
		/** Location snapshot (`BackupLocationSnapshot`) of where the archive was written; no credentials. */
		locationJson: text('location_json'),
	},
	(t) => [
		index('app_volume_snapshots_volume_idx').on(t.volumeId, t.createdAt),
		index('app_volume_snapshots_status_idx').on(t.status),
	],
);

/**
 * One-time codes for `skif login --web`. The CLI generates a PKCE verifier, the dashboard
 * approves the request and redirects the code to loopback, and the CLI exchanges it for an API
 * key. Only the hash is stored, the code expires quickly, and each code can be redeemed once.
 */
export const cliLoginCodes = sqliteTable(
	'cli_login_codes',
	{
		codeHash: text('code_hash').primaryKey(),
		userId: text('user_id').notNull(),
		redirectUri: text('redirect_uri').notNull(),
		codeChallenge: text('code_challenge').notNull(),
		expiresAt: integer('expires_at').notNull(),
		usedAt: integer('used_at'),
		createdAt: integer('created_at').notNull().$defaultFn(now),
	},
	(t) => [index('cli_login_codes_expires_idx').on(t.expiresAt)],
);

export const projects = sqliteTable(
	'projects',
	{
		id: text('id').primaryKey(),
		orgId: text('org_id').notNull(),
		slug: text('slug').notNull(),
		name: text('name').notNull(),
		runtime: text('runtime', { enum: ['static', 'process', 'container'] })
			.notNull()
			.default('static'),
		/**
		 * Effective tier, including the fourth one (D110): a function stores `runtime = "process"`
		 * here as `"function"` so the legacy CHECK keeps accepting the row. NULL on pre-0039 rows.
		 */
		runtimeName: text('runtime_name', { enum: ['static', 'process', 'container', 'function'] }),
		/** `edge`, `auto`, or a specific node id. */
		placement: text('placement').notNull().default('edge'),
		/** Optional constraint spec (`PlacementSpec`); the shorthand above still wins when null. */
		placementJson: text('placement_json'),
		productionDeploymentId: text('production_deployment_id'),
		productionAccess: text('production_access', { enum: ['public', 'password', 'platform'] })
			.notNull()
			.default('public'),
		previewAccess: text('preview_access', { enum: ['public', 'password', 'platform'] })
			.notNull()
			.default('platform'),
		/**
		 * Legacy shared password hash (one per project, both scopes). Superseded by the per-scope
		 * hashes below (0054); no longer read or written, kept because migrations are additive.
		 */
		accessSecretHash: text('access_secret_hash'),
		/** Hashed password (scrypt) for production in `password` mode. Never returned by the API. */
		productionPasswordHash: text('production_password_hash'),
		/** Hashed password (scrypt) for previews in `password` mode. Never returned by the API. */
		previewPasswordHash: text('preview_password_hash'),
		/**
		 * Visitor-session epoch. "Sign out everyone" bumps it, which rotates the project's site key, so
		 * every cookie and callback token signed with the old key stops verifying on the agents.
		 */
		siteSessionEpoch: integer('site_session_epoch').notNull().default(0),
		/** Last parsed site config, used to compile routes before a deployment exists. */
		siteConfigJson: text('site_config_json'),
		/** Tier 2/3 runtime spec applied to new deployments (validated by @skiff/contracts). */
		workloadJson: text('workload_json'),
		createdBy: text('created_by').notNull(),
		deletedAt: integer('deleted_at'),
		purgeAt: integer('purge_at'),
		createdAt: integer('created_at').notNull().$defaultFn(now),
		updatedAt: integer('updated_at').notNull().$defaultFn(now),
	},
	(t) => [
		uniqueIndex('projects_slug_idx').on(t.slug),
		index('projects_org_idx').on(t.orgId),
		index('projects_deleted_idx').on(t.deletedAt),
	],
);

export const slugRedirects = sqliteTable(
	'slug_redirects',
	{
		id: text('id').primaryKey(),
		fromSlug: text('from_slug').notNull(),
		projectId: text('project_id').notNull(),
		orgId: text('org_id').notNull(),
		expiresAt: integer('expires_at').notNull(),
		createdAt: integer('created_at').notNull().$defaultFn(now),
	},
	(t) => [uniqueIndex('slug_redirects_from_idx').on(t.fromSlug)],
);

export const uploadSessions = sqliteTable(
	'upload_sessions',
	{
		id: text('id').primaryKey(),
		orgId: text('org_id').notNull(),
		projectId: text('project_id'),
		kind: text('kind', { enum: ['inline', 'presigned'] }).notNull(),
		status: text('status', { enum: ['pending', 'finalized', 'expired', 'failed'] })
			.notNull()
			.default('pending'),
		objectKey: text('object_key').notNull(),
		storage: text('storage', { enum: ['local', 'r2'] }).notNull(),
		fileCount: integer('file_count'),
		totalBytes: integer('total_bytes'),
		sha256: text('sha256'),
		error: text('error'),
		createdBy: text('created_by').notNull(),
		expiresAt: integer('expires_at').notNull(),
		finalizedAt: integer('finalized_at'),
		createdAt: integer('created_at').notNull().$defaultFn(now),
	},
	(t) => [index('uploads_org_idx').on(t.orgId), index('uploads_status_idx').on(t.status)],
);

export const releases = sqliteTable(
	'releases',
	{
		id: text('id').primaryKey(),
		orgId: text('org_id').notNull(),
		sha256: text('sha256').notNull(),
		objectKey: text('object_key').notNull(),
		storage: text('storage', { enum: ['local', 'r2'] }).notNull(),
		sizeBytes: integer('size_bytes').notNull(),
		fileCount: integer('file_count').notNull(),
		/** JSON array of `{ path, size, sha256 }`. */
		manifestJson: text('manifest_json').notNull(),
		precompressed: integer('precompressed', { mode: 'boolean' }).notNull().default(false),
		createdBy: text('created_by').notNull(),
		createdAt: integer('created_at').notNull().$defaultFn(now),
	},
	(t) => [
		uniqueIndex('releases_org_sha_idx').on(t.orgId, t.sha256),
		index('releases_org_idx').on(t.orgId),
	],
);

export const configSnapshots = sqliteTable('config_snapshots', {
	id: text('id').primaryKey(),
	orgId: text('org_id').notNull(),
	hash: text('hash').notNull(),
	/** Parsed `skiff.json`, `_redirects` and `_headers`. */
	siteConfigJson: text('site_config_json').notNull(),
	/** Plain environment variables (readable). Secret references are separate. */
	envJson: text('env_json').notNull().default('{}'),
	/** JSON array of `{ name, secretId, version }`; values never live here. */
	secretRefsJson: text('secret_refs_json').notNull().default('[]'),
	createdAt: integer('created_at').notNull().$defaultFn(now),
});

export const deployments = sqliteTable(
	'deployments',
	{
		id: text('id').primaryKey(),
		orgId: text('org_id').notNull(),
		projectId: text('project_id').notNull(),
		releaseId: text('release_id').notNull(),
		configSnapshotId: text('config_snapshot_id').notNull(),
		/** URL-safe 10-char id used in `<slug>--<shortId>`. */
		shortId: text('short_id').notNull(),
		/** Named environment this deployment belongs to (production is created per project). */
		environmentId: text('environment_id'),
		runtime: text('runtime', { enum: ['static', 'process', 'container'] })
			.notNull()
			.default('static'),
		/** Effective tier including `function` (D110); NULL on pre-0039 rows. */
		runtimeName: text('runtime_name', { enum: ['static', 'process', 'container', 'function'] }),
		/** Runtime spec snapshot; rollback restores code and config (D17). */
		workloadJson: text('workload_json'),
		status: text('status', { enum: ['pending', 'active', 'inactive', 'failed', 'deleted'] })
			.notNull()
			.default('pending'),
		previewHost: text('preview_host').notNull(),
		pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
		message: text('message'),
		nodeId: text('node_id'),
		createdBy: text('created_by').notNull(),
		createdAt: integer('created_at').notNull().$defaultFn(now),
		activatedAt: integer('activated_at'),
		/** When this deployment last became production (promotion history; rollback target order). */
		promotedAt: integer('promoted_at'),
		deletedAt: integer('deleted_at'),
	},
	(t) => [
		uniqueIndex('deployments_short_idx').on(t.shortId),
		index('deployments_project_idx').on(t.projectId),
		index('deployments_status_idx').on(t.status),
		index('deployments_promoted_idx').on(t.projectId, t.promotedAt),
	],
);

export const shareLinks = sqliteTable(
	'share_links',
	{
		id: text('id').primaryKey(),
		orgId: text('org_id').notNull(),
		projectId: text('project_id').notNull(),
		/** Null means "whatever production points at". */
		deploymentId: text('deployment_id'),
		tokenHash: text('token_hash').notNull(),
		expiresAt: integer('expires_at'),
		maxVisitors: integer('max_visitors'),
		maxRedemptions: integer('max_redemptions'),
		sessionTtlSeconds: integer('session_ttl_seconds').notNull().default(3600),
		allowedEmailsJson: text('allowed_emails_json').notNull().default('[]'),
		note: text('note'),
		redemptions: integer('redemptions').notNull().default(0),
		revokedAt: integer('revoked_at'),
		createdBy: text('created_by').notNull(),
		createdAt: integer('created_at').notNull().$defaultFn(now),
	},
	(t) => [index('share_links_project_idx').on(t.projectId), uniqueIndex('share_links_token_idx').on(t.tokenHash)],
);

export const shareRedemptions = sqliteTable(
	'share_redemptions',
	{
		id: text('id').primaryKey(),
		shareLinkId: text('share_link_id').notNull(),
		visitorHash: text('visitor_hash').notNull(),
		email: text('email'),
		redeemedAt: integer('redeemed_at').notNull().$defaultFn(now),
		expiresAt: integer('expires_at').notNull(),
		revokedAt: integer('revoked_at'),
		/** The project's `site_session_epoch` when this session was minted; older epochs are signed out. */
		siteEpoch: integer('site_epoch').notNull().default(0),
	},
	(t) => [index('redemptions_link_idx').on(t.shareLinkId)],
);

export const domains = sqliteTable(
	'domains',
	{
		id: text('id').primaryKey(),
		orgId: text('org_id').notNull(),
		projectId: text('project_id').notNull(),
		hostname: text('hostname').notNull(),
		kind: text('kind', { enum: ['custom', 'apex'] }).notNull().default('custom'),
		status: text('status', { enum: ['pending', 'verified', 'active', 'failed'] })
			.notNull()
			.default('pending'),
		verificationToken: text('verification_token'),
		verifiedAt: integer('verified_at'),
		/** Reverse the `www` sibling to the apex (or vice versa); see DomainService. */
		redirectWww: integer('redirect_www', { mode: 'boolean' }).notNull().default(false),
		/** Cloudflare record id, when the connected account created it automatically. */
		cloudflareRecordId: text('cloudflare_record_id'),
		lastCheckedAt: integer('last_checked_at'),
		lastError: text('last_error'),
		createdAt: integer('created_at').notNull().$defaultFn(now),
	},
	(t) => [uniqueIndex('domains_host_idx').on(t.hostname), index('domains_project_idx').on(t.projectId)],
);

export const environments = sqliteTable(
	'environments',
	{
		id: text('id').primaryKey(),
		orgId: text('org_id').notNull(),
		projectId: text('project_id').notNull(),
		name: text('name').notNull(),
		slug: text('slug').notNull(),
		isProduction: integer('is_production', { mode: 'boolean' }).notNull().default(false),
		/** Access mode for this environment's host; mirrors the project preview default. */
		access: text('access', { enum: ['public', 'password', 'platform'] })
			.notNull()
			.default('platform'),
		/**
		 * Hashed password (scrypt) when `access` is `password`. Never returned by the API. Unused for
		 * the production environment, which follows the project's production password.
		 */
		passwordHash: text('password_hash'),
		/** Deployment served at `<slug>--<env>.<contentDomain>`; production uses the project pointer. */
		deploymentId: text('deployment_id'),
		createdAt: integer('created_at').notNull().$defaultFn(now),
		updatedAt: integer('updated_at').notNull().$defaultFn(now),
	},
	(t) => [
		uniqueIndex('environments_project_slug_idx').on(t.projectId, t.slug),
		index('environments_project_idx').on(t.projectId),
	],
);

/**
 * The current runtime spec for an app project. One row per project; the spec is snapshotted onto
 * each deployment so rollback restores the runtime config too (D17).
 */
export const workloads = sqliteTable(
	'workloads',
	{
		id: text('id').primaryKey(),
		orgId: text('org_id').notNull(),
		projectId: text('project_id').notNull(),
		deploymentId: text('deployment_id').notNull(),
		nodeId: text('node_id'),
		runtime: text('runtime', { enum: ['process', 'container'] }).notNull(),
		/** Effective tier including `function` (D110); NULL on pre-0039 rows. */
		runtimeName: text('runtime_name', { enum: ['static', 'process', 'container', 'function'] }),
		status: text('status', { enum: ['pending', 'starting', 'running', 'failed', 'stopped'] })
			.notNull()
			.default('pending'),
		/** Validated WorkloadSpec (no secret values). */
		specJson: text('spec_json').notNull(),
		memoryMb: integer('memory_mb').notNull(),
		cpus: integer('cpus').notNull().default(1),
		upstream: text('upstream'),
		message: text('message'),
		/** Bumped by a console restart (D127); folded into the activation version. */
		restartGeneration: integer('restart_generation').notNull().default(0),
		createdAt: integer('created_at').notNull().$defaultFn(now),
		updatedAt: integer('updated_at').notNull().$defaultFn(now),
	},
	(t) => [
		uniqueIndex('workloads_project_idx').on(t.projectId),
		index('workloads_node_idx').on(t.nodeId),
		index('workloads_status_idx').on(t.status),
	],
);

/**
 * Managed databases (docs/DATABASES.md, D55). `owner_secret` / `monitor_secret` hold
 * `nonce.ciphertext` sealed with the org data key; they are never returned by list/get.
 */
export const databases = sqliteTable(
	'databases',
	{
		id: text('id').primaryKey(),
		orgId: text('org_id').notNull(),
		name: text('name').notNull(),
		// Mirrors `databaseEngines` in @skiff/contracts. Stored in `engine_name` (0028): the original
		// `engine` column has a Postgres-only CHECK and is left at its default.
		engine: text('engine_name', { enum: ['postgres', 'mysql', 'mariadb', 'mongodb', 'valkey', 'redis', 'clickhouse'] })
			.notNull()
			.default('postgres'),
		version: text('version').notNull(),
		/** Image variant chosen at create (D126); mirrors `databaseVariants` in @skiff/contracts. */
		variant: text('variant', { enum: ['standard', 'postgis', 'pg_cron'] }).notNull().default('standard'),
		nodeId: text('node_id').notNull(),
		hostPort: integer('host_port').notNull(),
		memoryMb: integer('memory_mb').notNull(),
		cpus: real('cpus').notNull().default(1),
		storageMb: integer('storage_mb').notNull().default(10_240),
		/** Node volume holding the data dir; null keeps the helper state dir (D74). */
		volumeId: text('volume_id'),
		/** PgBouncer sidecar (docs/DATABASES.md §11); null port when disabled. */
		poolerEnabled: integer('pooler_enabled', { mode: 'boolean' }).notNull().default(false),
		poolerPort: integer('pooler_port'),
		/** Bumped by an explicit restart so the agent re-applies the unit without a config change. */
		restartGeneration: integer('restart_generation').notNull().default(0),
		/** Counts replica promotions (C7, 0069); replicas follow the generation they were created under. */
		primaryGeneration: integer('primary_generation').notNull().default(0),
		/** Set while a pooler-only restart is waiting for the node to acknowledge it. */
		poolerRestartRequestedAt: integer('pooler_restart_requested_at'),
		status: text('status', { enum: ['pending', 'starting', 'running', 'failed', 'stopped'] })
			.notNull()
			.default('pending'),
		message: text('message'),
		ownerSecret: text('owner_secret').notNull(),
		monitorSecret: text('monitor_secret').notNull(),
		/** Latest sampled `pg_database_size`. */
		sizeBytes: integer('size_bytes'),
		/** Latest table snapshot (`DatabaseTableStat[]`). */
		statsJson: text('stats_json'),
		statsAt: integer('stats_at'),
		/** Requested allowlisted extensions (`DatabaseExtension[]`). */
		extensionsJson: text('extensions_json').notNull().default('[]'),
		/** Latest slow-query snapshot (`DatabaseSlowQuery[]`). */
		slowQueriesJson: text('slow_queries_json'),
		slowQueriesAt: integer('slow_queries_at'),
		/** Backup policy (docs/DATABASES.md §9). */
		backupEnabled: integer('backup_enabled', { mode: 'boolean' }).notNull().default(true),
		backupSchedule: text('backup_schedule').notNull().default('0 3 * * *'),
		backupRetentionDays: integer('backup_retention_days').notNull().default(7),
		nextBackupAt: integer('next_backup_at'),
		lastBackupAt: integer('last_backup_at'),
		lastBackupStatus: text('last_backup_status', { enum: ['pending', 'running', 'ok', 'failed'] }),
		lastBackupError: text('last_backup_error'),
		lastVerifiedAt: integer('last_verified_at'),
		/** Backup being restored into this database; cleared when the node reports success. */
		pendingRestoreId: text('pending_restore_id'),
		createdBy: text('created_by').notNull(),
		createdAt: integer('created_at').notNull().$defaultFn(now),
		updatedAt: integer('updated_at').notNull().$defaultFn(now),
		deletedAt: integer('deleted_at'),
		purgeAt: integer('purge_at'),
		/** Set when the purge was handed to the node; the row goes once the node reports it (D59). */
		purgeRequestedAt: integer('purge_requested_at'),
		/**
		 * Operator-managed public connection URL, sealed with the org data key. Only returned by
		 * an audited reveal; every list/get view carries metadata only.
		 */
		publicUrlSealed: text('public_url_sealed'),
		publicUrlUpdatedAt: integer('public_url_updated_at'),
		publicUrlUpdatedBy: text('public_url_updated_by'),
		/** Read-only studio principal password (plan 22 track G), sealed with the org data key. */
		studioRoSecret: text('studio_ro_secret'),
		/** Bumped when the principal must be (re)applied on the node. */
		studioRoGeneration: integer('studio_ro_generation').notNull().default(0),
		/** The generation the node last confirmed; ready when it equals `studioRoGeneration`. */
		studioRoReadyGeneration: integer('studio_ro_ready_generation').notNull().default(0),
		/** Why the current generation failed on the node; never a credential. */
		studioRoError: text('studio_ro_error'),
	},
	(t) => [
		uniqueIndex('databases_org_name_idx').on(t.orgId, t.name),
		uniqueIndex('databases_node_port_idx').on(t.nodeId, t.hostPort),
		index('databases_node_idx').on(t.nodeId),
		index('databases_deleted_idx').on(t.deletedAt),
	],
);

export const databaseAttachments = sqliteTable(
	'database_attachments',
	{
		id: text('id').primaryKey(),
		orgId: text('org_id').notNull(),
		databaseId: text('database_id').notNull(),
		projectId: text('project_id').notNull(),
		envPrefix: text('env_prefix').notNull().default('DATABASE'),
		/** Credential row this attachment consumes; null on rows created before named credentials. */
		credentialId: text('credential_id'),
		createdBy: text('created_by').notNull(),
		createdAt: integer('created_at').notNull().$defaultFn(now),
	},
	(t) => [
		uniqueIndex('database_attachments_pair_idx').on(t.databaseId, t.projectId),
		uniqueIndex('database_attachments_prefix_idx').on(t.projectId, t.envPrefix),
		index('database_attachments_project_idx').on(t.projectId),
	],
);

/**
 * Managed database backups (docs/DATABASES.md §8). The dump itself lives on the backup target
 * recorded in `targetId`/`locationJson`; this row is only the index/metadata. `sha256` is computed by the node while it
 * uploads, so a corrupt artifact is rejected before it is ever offered for restore.
 */
export const databaseBackups = sqliteTable(
	'database_backups',
	{
		id: text('id').primaryKey(),
		orgId: text('org_id').notNull(),
		databaseId: text('database_id').notNull(),
		kind: text('kind', { enum: ['manual', 'scheduled'] }).notNull(),
		status: text('status', { enum: ['pending', 'running', 'ok', 'failed'] })
			.notNull()
			.default('pending'),
		objectKey: text('object_key').notNull(),
		sizeBytes: integer('size_bytes'),
		sha256: text('sha256'),
		pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
		error: text('error'),
		verifiedAt: integer('verified_at'),
		restoredDatabaseId: text('restored_database_id'),
		createdBy: text('created_by').notNull(),
		createdAt: integer('created_at').notNull().$defaultFn(now),
		startedAt: integer('started_at'),
		finishedAt: integer('finished_at'),
		expiresAt: integer('expires_at'),
		/**
		 * Where the artifact was written (0053). Restore, retention and purge use this record, never
		 * the target that applies now. Null `targetId` is the platform object store; a null
		 * `locationJson` is a legacy row and falls back to the current resolution.
		 */
		targetId: text('target_id'),
		targetName: text('target_name'),
		locationJson: text('location_json'),
	},
	(t) => [
		index('database_backups_database_idx').on(t.databaseId, t.createdAt),
		index('database_backups_status_idx').on(t.status),
		index('database_backups_target_idx').on(t.targetId, t.status),
		index('database_backups_expires_idx').on(t.expiresAt),
	],
);

/**
 * Where platform and managed-data backups are written (plan 05, docs/BACKUPS.md). A null `orgId`
 * is the platform default; an org row overrides it. Credentials are sealed with the org data key
 * (the platform key for a platform row) and never selected by a view.
 */
export const backupTargets = sqliteTable(
	'backup_targets',
	{
		id: text('id').primaryKey(),
		orgId: text('org_id'),
		name: text('name').notNull(),
		kind: text('kind', { enum: ['local', 's3'] }).notNull(),
		/** Local directory; null for S3 targets. */
		path: text('path'),
		endpoint: text('endpoint'),
		bucket: text('bucket'),
		region: text('region'),
		pathPrefix: text('path_prefix').notNull().default(''),
		forcePathStyle: integer('force_path_style', { mode: 'boolean' }).notNull().default(true),
		accessKeySealed: text('access_key_sealed'),
		secretSealed: text('secret_sealed'),
		writeOnly: integer('write_only', { mode: 'boolean' }).notNull().default(false),
		objectLock: integer('object_lock', { mode: 'boolean' }).notNull().default(false),
		status: text('status', { enum: ['pending', 'ok', 'failed'] }).notNull().default('pending'),
		lastCheckedAt: integer('last_checked_at'),
		lastError: text('last_error'),
		lastTestJson: text('last_test_json'),
		createdAt: integer('created_at').notNull().$defaultFn(now),
		updatedAt: integer('updated_at').notNull().$defaultFn(now),
	},
	(t) => [
		index('backup_targets_org_idx').on(t.orgId, t.createdAt),
	],
);

/**
 * Credential rotation for a managed database (docs/DATABASES.md §4). The new password is sealed
 * here until the node reports that `ALTER ROLE` succeeded; only then does it replace the live
 * secret, so a failed rotation never locks an app out.
 */
export const databaseRotations = sqliteTable(
	'database_rotations',
	{
		id: text('id').primaryKey(),
		orgId: text('org_id').notNull(),
		databaseId: text('database_id').notNull(),
		role: text('role', { enum: ['owner', 'monitor'] }).notNull(),
		status: text('status', { enum: ['pending', 'running', 'ok', 'failed'] })
			.notNull()
			.default('pending'),
		secretSealed: text('secret_sealed').notNull(),
		error: text('error'),
		createdBy: text('created_by').notNull(),
		createdAt: integer('created_at').notNull().$defaultFn(now),
		finishedAt: integer('finished_at'),
	},
	(t) => [index('database_rotations_database_idx').on(t.databaseId, t.createdAt)],
);

/**
 * Named database credentials (plan 04b). Owner and monitor rows mirror the database's built-in
 * secrets; app/readonly/backup rows are provisioned by the node. `pending_secret_sealed` holds a
 * new password until the node confirms the role change, so a failed rotation never locks anyone out.
 */
export const databaseCredentials = sqliteTable(
	'database_credentials',
	{
		id: text('id').primaryKey(),
		orgId: text('org_id').notNull(),
		databaseId: text('database_id').notNull(),
		role: text('role', { enum: ['owner', 'app', 'monitor', 'readonly', 'backup'] }).notNull(),
		username: text('username').notNull(),
		secretSealed: text('secret_sealed'),
		pendingSecretSealed: text('pending_secret_sealed'),
		purpose: text('purpose'),
		status: text('status', { enum: ['pending', 'ready', 'failed', 'revoking', 'revoked'] })
			.notNull()
			.default('ready'),
		lastUsedAt: integer('last_used_at'),
		expiresAt: integer('expires_at'),
		revokedAt: integer('revoked_at'),
		createdBy: text('created_by').notNull(),
		createdAt: integer('created_at').notNull().$defaultFn(now),
		updatedAt: integer('updated_at').notNull().$defaultFn(now),
	},
	(t) => [
		index('database_credentials_database_idx').on(t.databaseId, t.role),
		uniqueIndex('database_credentials_username_idx').on(t.databaseId, t.username),
	],
);

/**
 * Managed object storage (docs/OBJECT-STORAGE.md, S1). `root_secret` and attachment
 * `secret_sealed` hold `nonce.ciphertext` sealed with the org data key; never returned by list/get.
 */
export const storageInstances = sqliteTable(
	'storage_instances',
	{
		id: text('id').primaryKey(),
		orgId: text('org_id').notNull(),
		name: text('name').notNull(),
		engine: text('engine', { enum: ['rustfs'] }).notNull().default('rustfs'),
		version: text('version').notNull(),
		nodeId: text('node_id').notNull(),
		hostPort: integer('host_port').notNull(),
		memoryMb: integer('memory_mb').notNull(),
		cpus: real('cpus').notNull().default(1),
		storageMb: integer('storage_mb').notNull().default(10_240),
		/** Node volume holding the data dir; null keeps the helper state dir (D74). */
		volumeId: text('volume_id'),
		/** Bumped by an explicit restart; folded into the activation version (D82). */
		restartGeneration: integer('restart_generation').notNull().default(0),
		public: integer('public', { mode: 'boolean' }).notNull().default(false),
		/** `<name>--s3.<contentDomain>` while public (and while trashed, so restore gets it back). */
		publicHost: text('public_host'),
		status: text('status', { enum: ['pending', 'starting', 'running', 'failed', 'stopped'] })
			.notNull()
			.default('pending'),
		message: text('message'),
		rootAccessKey: text('root_access_key').notNull(),
		rootSecret: text('root_secret').notNull(),
		/** Latest sampled totals across buckets. */
		usedBytes: integer('used_bytes'),
		objects: integer('objects'),
		statsAt: integer('stats_at'),
		createdBy: text('created_by').notNull(),
		createdAt: integer('created_at').notNull().$defaultFn(now),
		updatedAt: integer('updated_at').notNull().$defaultFn(now),
		deletedAt: integer('deleted_at'),
		purgeAt: integer('purge_at'),
		/** Set when the purge was handed to the node; the row goes once the node reports it (S8). */
		purgeRequestedAt: integer('purge_requested_at'),
		/** Node still holding this instance's old data after a move (D97); purged, then cleared. */
		purgeNodeId: text('purge_node_id'),
		/** Staged root-key rotation (0059): activated with this pair until the node confirms it. */
		rootPendingAccessKey: text('root_pending_access_key'),
		rootPendingSecret: text('root_pending_secret'),
		rootRotationStartedAt: integer('root_rotation_started_at'),
		rootRotationError: text('root_rotation_error'),
		rootRotatedAt: integer('root_rotated_at'),
	},
	(t) => [
		uniqueIndex('storage_instances_org_name_idx').on(t.orgId, t.name),
		uniqueIndex('storage_instances_node_port_idx').on(t.nodeId, t.hostPort),
		uniqueIndex('storage_instances_public_host_idx').on(t.publicHost),
		index('storage_instances_node_idx').on(t.nodeId),
		index('storage_instances_deleted_idx').on(t.deletedAt),
		index('storage_instances_purge_node_idx').on(t.purgeNodeId),
	],
);

export const storageBuckets = sqliteTable(
	'storage_buckets',
	{
		id: text('id').primaryKey(),
		orgId: text('org_id').notNull(),
		storageId: text('storage_id').notNull(),
		name: text('name').notNull(),
		access: text('access', { enum: ['private', 'public-read'] }).notNull().default('private'),
		/** Desired-state bucket configuration, converged by the node's agent. */
		versioning: integer('versioning', { mode: 'boolean' }).notNull().default(false),
		/** `BucketLifecycleRule[]`. */
		lifecycleJson: text('lifecycle_json').notNull().default('[]'),
		/** `BucketCorsRule[]`. */
		corsJson: text('cors_json').notNull().default('[]'),
		/** Hard byte cap; null means unlimited. */
		quotaBytes: integer('quota_bytes'),
		/** `BucketObjectLock`; create-only and irreversible. */
		objectLockJson: text('object_lock_json'),
		/** Bumped on every desired-state change; the agent echoes it in its report. */
		configVersion: integer('config_version').notNull().default(1),
		configStatus: text('config_status', { enum: ['pending', 'converged', 'error', 'unsupported'] })
			.notNull()
			.default('pending'),
		configMessage: text('config_message'),
		lastConvergedAt: integer('last_converged_at'),
		sizeBytes: integer('size_bytes'),
		objects: integer('objects'),
		statsAt: integer('stats_at'),
		/** Set by a bucket delete; the agent deletes it and the row goes on its report. */
		deleteRequestedAt: integer('delete_requested_at'),
		deleteForce: integer('delete_force', { mode: 'boolean' }).notNull().default(false),
		/** The agent found the bucket non-empty and left it; a forced delete clears this. */
		deleteBlocked: integer('delete_blocked', { mode: 'boolean' }).notNull().default(false),
		createdBy: text('created_by').notNull(),
		createdAt: integer('created_at').notNull().$defaultFn(now),
	},
	(t) => [uniqueIndex('storage_buckets_name_idx').on(t.storageId, t.name)],
);

/** Share links for one object. Only a hash of the browser token is stored; never a key. */
export const storageShareLinks = sqliteTable(
	'storage_share_links',
	{
		id: text('id').primaryKey(),
		orgId: text('org_id').notNull(),
		storageId: text('storage_id').notNull(),
		bucket: text('bucket').notNull(),
		key: text('key').notNull(),
		method: text('method', { enum: ['GET', 'PUT'] }).notNull().default('GET'),
		tokenHash: text('token_hash').notNull(),
		expiresAt: integer('expires_at').notNull(),
		maxDownloads: integer('max_downloads'),
		downloads: integer('downloads').notNull().default(0),
		revokedAt: integer('revoked_at'),
		createdBy: text('created_by').notNull(),
		createdAt: integer('created_at').notNull().$defaultFn(now),
	},
	(t) => [
		uniqueIndex('storage_share_links_token_idx').on(t.tokenHash),
		index('storage_share_links_storage_idx').on(t.storageId),
	],
);

/**
 * Managed queue brokers (docs/BROKERS.md, D111). One broker server per row, run as a tier-3
 * container on `nodeId`. `engine` is unconstrained (0048); the contracts registry validates it.
 */
export const brokers = sqliteTable(
	'brokers',
	{
		id: text('id').primaryKey(),
		orgId: text('org_id').notNull(),
		name: text('name').notNull(),
		// Mirrors `brokerEngines` in @skiff/contracts.
		engine: text('engine', { enum: ['nats'] }).notNull().default('nats'),
		version: text('version').notNull(),
		nodeId: text('node_id').notNull(),
		hostPort: integer('host_port').notNull(),
		memoryMb: integer('memory_mb').notNull(),
		cpus: real('cpus').notNull().default(0.5),
		/** Persistent message store cap (JetStream file store), in MB. */
		storageMb: integer('storage_mb').notNull().default(2_048),
		/** Node volume holding the data dir; null keeps the helper state dir (D74). */
		volumeId: text('volume_id'),
		/** Bumped by an explicit restart; folded into the activation version. */
		restartGeneration: integer('restart_generation').notNull().default(0),
		status: text('status', { enum: ['pending', 'starting', 'running', 'failed', 'stopped'] })
			.notNull()
			.default('pending'),
		message: text('message'),
		/** The single client user's password, sealed with the org data key. */
		ownerSecret: text('owner_secret').notNull(),
		createdBy: text('created_by').notNull(),
		createdAt: integer('created_at').notNull().$defaultFn(now),
		updatedAt: integer('updated_at').notNull().$defaultFn(now),
		deletedAt: integer('deleted_at'),
		purgeAt: integer('purge_at'),
		/** Set when the purge was handed to the node; the row goes once the node reports it (D59). */
		purgeRequestedAt: integer('purge_requested_at'),
		/** Newest sample from the node (D123): JetStream file store in use and messages held. */
		storeBytes: integer('store_bytes'),
		messages: integer('messages'),
		/** Newest stream listing (`BrokerStreamStats[]` as JSON). */
		queueStats: text('queue_stats'),
		queueStatsTruncated: integer('queue_stats_truncated', { mode: 'boolean' }).notNull().default(false),
		statsAt: integer('stats_at'),
	},
	(t) => [
		uniqueIndex('brokers_org_name_idx').on(t.orgId, t.name),
		uniqueIndex('brokers_node_port_idx').on(t.nodeId, t.hostPort),
		index('brokers_node_idx').on(t.nodeId),
		index('brokers_deleted_idx').on(t.deletedAt),
	],
);

export const brokerAttachments = sqliteTable(
	'broker_attachments',
	{
		id: text('id').primaryKey(),
		orgId: text('org_id').notNull(),
		brokerId: text('broker_id').notNull(),
		projectId: text('project_id').notNull(),
		envPrefix: text('env_prefix').notNull().default('NATS'),
		createdBy: text('created_by').notNull(),
		createdAt: integer('created_at').notNull().$defaultFn(now),
	},
	(t) => [
		uniqueIndex('broker_attachments_pair_idx').on(t.brokerId, t.projectId),
		uniqueIndex('broker_attachments_prefix_idx').on(t.projectId, t.envPrefix),
		index('broker_attachments_project_idx').on(t.projectId),
	],
);

/** Broker runtime logs; the same shape as `service_log_events`, whose `kind` CHECK predates brokers. */
export const brokerLogEvents = sqliteTable(
	'broker_log_events',
	{
		seq: integer('seq').primaryKey({ autoIncrement: true }),
		orgId: text('org_id').notNull(),
		brokerId: text('broker_id').notNull(),
		nodeId: text('node_id'),
		source: text('source', { enum: ['runtime', 'system'] }).notNull().default('runtime'),
		stream: text('stream', { enum: ['stdout', 'stderr', 'system'] }).notNull().default('stdout'),
		level: text('level', { enum: ['debug', 'info', 'warn', 'error'] }).notNull().default('info'),
		message: text('message').notNull(),
		ts: integer('ts').notNull(),
	},
	(t) => [
		index('broker_log_events_broker_seq_idx').on(t.brokerId, t.seq),
		index('broker_log_events_ts_idx').on(t.ts),
	],
);

export const storageAttachments = sqliteTable(
	'storage_attachments',
	{
		id: text('id').primaryKey(),
		orgId: text('org_id').notNull(),
		storageId: text('storage_id').notNull(),
		projectId: text('project_id').notNull(),
		envPrefix: text('env_prefix').notNull().default('S3'),
		/** `StorageGrant[]`. */
		grantsJson: text('grants_json').notNull(),
		accessKeyId: text('access_key_id').notNull(),
		secretSealed: text('secret_sealed').notNull(),
		/** Named key row this attachment consumes; null on rows created before named keys. */
		credentialId: text('credential_id'),
		createdBy: text('created_by').notNull(),
		createdAt: integer('created_at').notNull().$defaultFn(now),
		updatedAt: integer('updated_at').notNull().$defaultFn(now),
	},
	(t) => [
		uniqueIndex('storage_attachments_pair_idx').on(t.storageId, t.projectId),
		uniqueIndex('storage_attachments_prefix_idx').on(t.projectId, t.envPrefix),
		uniqueIndex('storage_attachments_key_idx').on(t.accessKeyId),
		index('storage_attachments_project_idx').on(t.projectId),
	],
);

/**
 * Named storage keys (plan 04b): human/service access keys with bucket grants, independent of
 * project attachments. The agent's existing IAM reconciler consumes them as `objectStorage.users`;
 * secrets are sealed with the org key and only an interactive reveal returns them.
 */
export const storageKeys = sqliteTable(
	'storage_keys',
	{
		id: text('id').primaryKey(),
		orgId: text('org_id').notNull(),
		storageId: text('storage_id').notNull(),
		name: text('name').notNull(),
		accessKeyId: text('access_key_id').notNull(),
		secretSealed: text('secret_sealed').notNull(),
		grantsJson: text('grants_json').notNull(),
		purpose: text('purpose'),
		lastUsedAt: integer('last_used_at'),
		expiresAt: integer('expires_at'),
		revokedAt: integer('revoked_at'),
		createdBy: text('created_by').notNull(),
		createdAt: integer('created_at').notNull().$defaultFn(now),
		updatedAt: integer('updated_at').notNull().$defaultFn(now),
	},
	(t) => [
		uniqueIndex('storage_keys_name_idx').on(t.storageId, t.name),
		uniqueIndex('storage_keys_key_idx').on(t.accessKeyId),
		index('storage_keys_storage_idx').on(t.storageId),
	],
);

export const gitSources = sqliteTable(
	'git_sources',
	{
		id: text('id').primaryKey(),
		orgId: text('org_id').notNull(),
		projectId: text('project_id').notNull(),
		repoUrl: text('repo_url').notNull(),
		branch: text('branch').notNull().default('main'),
		rootDir: text('root_dir').notNull().default('.'),
		buildCommand: text('build_command').notNull(),
		outputDir: text('output_dir').notNull().default('dist'),
		/** Envelope-encrypted webhook secret; never returned by the API. */
		webhookSecret: text('webhook_secret'),
		enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
		createdBy: text('created_by').notNull(),
		createdAt: integer('created_at').notNull().$defaultFn(now),
		updatedAt: integer('updated_at').notNull().$defaultFn(now),
	},
	(t) => [uniqueIndex('git_sources_project_idx').on(t.projectId)],
);

export const builds = sqliteTable(
	'builds',
	{
		id: text('id').primaryKey(),
		orgId: text('org_id').notNull(),
		projectId: text('project_id').notNull(),
		gitSourceId: text('git_source_id').notNull(),
		status: text('status', { enum: ['queued', 'building', 'succeeded', 'failed', 'cancelled'] })
			.notNull()
			.default('queued'),
		ref: text('ref').notNull(),
		commitSha: text('commit_sha'),
		commitMessage: text('commit_message'),
		releaseId: text('release_id'),
		deploymentId: text('deployment_id'),
		/** Node that claimed the job (the homelab Builder, D3). */
		nodeId: text('node_id'),
		promote: integer('promote', { mode: 'boolean' }).notNull().default(true),
		/** Truncated tail for list views; the full log is kept in `log`. */
		logTail: text('log_tail'),
		log: text('log'),
		error: text('error'),
		createdBy: text('created_by').notNull(),
		createdAt: integer('created_at').notNull().$defaultFn(now),
		claimedAt: integer('claimed_at'),
		startedAt: integer('started_at'),
		finishedAt: integer('finished_at'),
	},
	(t) => [
		index('builds_project_idx').on(t.projectId),
		index('builds_status_idx').on(t.status),
		index('builds_created_idx').on(t.createdAt),
	],
);

/**
 * Ordered log drain (DESIGN §8). Builders and agents append small batches; the dashboard tails
 * `seq` over SSE. `seq` is the cursor, so a reconnect never depends on clock resolution.
 */
export const logEvents = sqliteTable(
	'log_events',
	{
		seq: integer('seq').primaryKey({ autoIncrement: true }),
		orgId: text('org_id').notNull(),
		projectId: text('project_id').notNull(),
		deploymentId: text('deployment_id'),
		buildId: text('build_id'),
		nodeId: text('node_id'),
		source: text('source', { enum: ['runtime', 'build', 'system'] }).notNull(),
		stream: text('stream', { enum: ['stdout', 'stderr', 'system'] }).notNull(),
		level: text('level', { enum: ['debug', 'info', 'warn', 'error'] })
			.notNull()
			.default('info'),
		message: text('message').notNull(),
		ts: integer('ts').notNull(),
		/** Set for a job run's output (0061); NULL for app, build and system lines. */
		jobRunId: text('job_run_id'),
	},
	(t) => [
		index('log_events_project_seq_idx').on(t.projectId, t.seq),
		index('log_events_deployment_seq_idx').on(t.deploymentId, t.seq),
		index('log_events_build_seq_idx').on(t.buildId, t.seq),
		index('log_events_ts_idx').on(t.ts),
		index('log_events_job_run_seq_idx').on(t.jobRunId, t.seq),
	],
);

/**
 * Jobs (plan 09, 0061): a named command on a process/container project, optionally on a
 * five-field UTC cron. `nextRunAt` is the next fire; NULL without a schedule or while paused.
 */
export const jobs = sqliteTable(
	'jobs',
	{
		id: text('id').primaryKey(),
		orgId: text('org_id').notNull(),
		projectId: text('project_id').notNull(),
		name: text('name').notNull(),
		commandJson: text('command_json').notNull(),
		schedule: text('schedule'),
		timeoutSeconds: integer('timeout_seconds').notNull(),
		concurrency: text('concurrency', { enum: ['forbid', 'allow', 'replace'] }).notNull().default('forbid'),
		maxRetries: integer('max_retries').notNull().default(0),
		enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
		nextRunAt: integer('next_run_at'),
		createdBy: text('created_by').notNull(),
		createdAt: integer('created_at').notNull().$defaultFn(now),
		updatedAt: integer('updated_at').notNull().$defaultFn(now),
	},
	(t) => [uniqueIndex('jobs_project_name_idx').on(t.projectId, t.name), index('jobs_due_idx').on(t.nextRunAt)],
);

/** One execution of a job, or a one-off command (`jobId` NULL). Leased by the project's node. */
export const jobRuns = sqliteTable(
	'job_runs',
	{
		id: text('id').primaryKey(),
		orgId: text('org_id').notNull(),
		projectId: text('project_id').notNull(),
		jobId: text('job_id'),
		jobName: text('job_name'),
		trigger: text('trigger', { enum: ['schedule', 'manual', 'retry'] }).notNull(),
		attempt: integer('attempt').notNull().default(1),
		retryOf: text('retry_of'),
		status: text('status', {
			enum: ['queued', 'running', 'succeeded', 'failed', 'timeout', 'cancelled', 'skipped'],
		})
			.notNull()
			.default('queued'),
		commandJson: text('command_json').notNull(),
		timeoutSeconds: integer('timeout_seconds').notNull(),
		nodeId: text('node_id'),
		workloadId: text('workload_id'),
		deploymentId: text('deployment_id'),
		exitCode: integer('exit_code'),
		error: text('error'),
		cancelRequested: integer('cancel_requested', { mode: 'boolean' }).notNull().default(false),
		leasedUntil: integer('leased_until').notNull().default(0),
		createdBy: text('created_by'),
		createdAt: integer('created_at').notNull().$defaultFn(now),
		runAt: integer('run_at').notNull(),
		startedAt: integer('started_at'),
		finishedAt: integer('finished_at'),
	},
	(t) => [
		index('job_runs_lease_idx').on(t.nodeId, t.status, t.runAt),
		index('job_runs_job_idx').on(t.jobId, t.createdAt),
		index('job_runs_project_idx').on(t.projectId, t.createdAt),
		index('job_runs_status_idx').on(t.status, t.runAt),
	],
);

/**
 * Runtime logs for managed services (docs/OBJECT-STORAGE.md, docs/DATABASES.md). Separate from
 * `log_events` because a managed service is an org resource with no project/deployment.
 */
export const serviceLogEvents = sqliteTable(
	'service_log_events',
	{
		seq: integer('seq').primaryKey({ autoIncrement: true }),
		orgId: text('org_id').notNull(),
		kind: text('kind', { enum: ['storage', 'database'] }).notNull(),
		serviceId: text('service_id').notNull(),
		nodeId: text('node_id'),
		source: text('source', { enum: ['runtime', 'system'] }).notNull().default('runtime'),
		stream: text('stream', { enum: ['stdout', 'stderr', 'system'] }).notNull().default('stdout'),
		level: text('level', { enum: ['debug', 'info', 'warn', 'error'] }).notNull().default('info'),
		message: text('message').notNull(),
		ts: integer('ts').notNull(),
	},
	(t) => [
		index('service_log_events_service_seq_idx').on(t.kind, t.serviceId, t.seq),
		index('service_log_events_ts_idx').on(t.ts),
	],
);

export const auditLog = sqliteTable(
	'audit_log',
	{
		id: text('id').primaryKey(),
		orgId: text('org_id'),
		actorType: text('actor_type', { enum: ['user', 'apiKey', 'mcp', 'system', 'agent'] }).notNull(),
		actorId: text('actor_id'),
		clientId: text('client_id'),
		action: text('action').notNull(),
		resource: text('resource').notNull(),
		resourceId: text('resource_id'),
		argsJson: text('args_json'),
		result: text('result', { enum: ['ok', 'error'] }).notNull(),
		error: text('error'),
		ipHash: text('ip_hash'),
		/** Set on the per-item rows a mass operation writes (docs/OPERATIONS.md §7). */
		operationId: text('operation_id'),
		createdAt: integer('created_at').notNull().$defaultFn(now),
	},
	(t) => [
		index('audit_org_idx').on(t.orgId),
		index('audit_operation_idx').on(t.operationId),
		index('audit_created_idx').on(t.createdAt),
		index('audit_action_idx').on(t.action),
	],
);

/**
 * Mass actions and prune runs (docs/OPERATIONS.md §2). An operation is planned (verdict per item),
 * then applied item by item; item status is persisted as it runs so a restart resumes where it
 * stopped.
 */
export const operations = sqliteTable(
	'operations',
	{
		id: text('id').primaryKey(),
		/** Null for a platform-scope prune. */
		orgId: text('org_id'),
		kind: text('kind', { enum: ['bulk', 'prune'] }).notNull(),
		action: text('action').notNull(),
		status: text('status', {
			enum: ['queued', 'planning', 'planned', 'applying', 'succeeded', 'partial', 'failed', 'cancelled', 'expired'],
		})
			.notNull()
			.default('queued'),
		/** What to do after planning: stop for review, or apply straight away. */
		stage: text('stage', { enum: ['plan', 'apply'] }).notNull().default('plan'),
		paramsJson: text('params_json'),
		summaryJson: text('summary_json'),
		phase: text('phase'),
		total: integer('total').notNull().default(0),
		done: integer('done').notNull().default(0),
		failed: integer('failed').notNull().default(0),
		cancelRequested: integer('cancel_requested', { mode: 'boolean' }).notNull().default(false),
		actorType: text('actor_type').notNull(),
		actorId: text('actor_id'),
		clientId: text('client_id'),
		/** The principal the run executes as (permissions are re-checked against it per item). */
		principalJson: text('principal_json').notNull(),
		idempotencyKey: text('idempotency_key'),
		heartbeatAt: integer('heartbeat_at'),
		planExpiresAt: integer('plan_expires_at'),
		createdAt: integer('created_at').notNull().$defaultFn(now),
		startedAt: integer('started_at'),
		finishedAt: integer('finished_at'),
	},
	(t) => [
		index('operations_org_idx').on(t.orgId, t.createdAt),
		index('operations_status_idx').on(t.status),
		uniqueIndex('operations_idempotency_idx').on(t.orgId, t.actorId, t.idempotencyKey),
	],
);

export const operationItems = sqliteTable(
	'operation_items',
	{
		operationId: text('operation_id').notNull(),
		seq: integer('seq').notNull(),
		category: text('category'),
		targetKind: text('target_kind').notNull(),
		targetId: text('target_id').notNull(),
		label: text('label'),
		verdict: text('verdict', { enum: ['ok', 'skip', 'blocked'] }).notNull(),
		reason: text('reason'),
		flagsJson: text('flags_json'),
		status: text('status', { enum: ['pending', 'succeeded', 'skipped', 'failed', 'cancelled'] })
			.notNull()
			.default('pending'),
		error: text('error'),
		bytes: integer('bytes'),
		/** Category-specific data the apply step needs (e.g. org id and object key). */
		dataJson: text('data_json'),
		updatedAt: integer('updated_at'),
	},
	(t) => [
		primaryKey({ columns: [t.operationId, t.seq] }),
		index('operation_items_status_idx').on(t.operationId, t.status),
	],
);

/**
 * Blueprint stacks an org has applied (plan 11, 0071). `managedJson` lists the resource keys the
 * stack created or adopted; only those can be pruned. The plan and its progress live in a
 * `blueprint.apply` operation.
 */
export const blueprints = sqliteTable(
	'blueprints',
	{
		id: text('id').primaryKey(),
		orgId: text('org_id').notNull(),
		name: text('name').notNull(),
		/** The last document that applied cleanly, normalised; null until one did. */
		documentJson: text('document_json'),
		documentHash: text('document_hash'),
		/** `string[]` of resource keys (`projects.shop-web`, `databases.shop-db`). */
		managedJson: text('managed_json').notNull().default('[]'),
		lastOperationId: text('last_operation_id'),
		lastStatus: text('last_status'),
		appliedPlanHash: text('applied_plan_hash'),
		appliedAt: integer('applied_at'),
		appliedBy: text('applied_by'),
		createdAt: integer('created_at').notNull().$defaultFn(now),
		updatedAt: integer('updated_at').notNull().$defaultFn(now),
	},
	(t) => [uniqueIndex('blueprints_org_name_idx').on(t.orgId, t.name)],
);

export const orgQuotas = sqliteTable('org_quotas', {
	orgId: text('org_id').primaryKey(),
	/** -1 means unlimited (owner org). */
	projects: integer('projects').notNull().default(-1),
	storageBytes: integer('storage_bytes').notNull().default(-1),
	retainedDeployments: integer('retained_deployments').notNull().default(-1),
	maxUploadBytes: integer('max_upload_bytes').notNull().default(-1),
	/** Extended org quotas (plan 16, migration 0025). Null and -1 both mean unlimited. */
	databases: integer('databases').default(-1),
	databaseStorageBytes: integer('database_storage_bytes').default(-1),
	storageInstances: integer('storage_instances').default(-1),
	storageObjects: integer('storage_objects').default(-1),
	appVolumes: integer('app_volumes').default(-1),
	appVolumeBytes: integer('app_volume_bytes').default(-1),
	jobs: integer('jobs').default(-1),
	jobRunsPerDay: integer('job_runs_per_day').default(-1),
	buildsPerDay: integer('builds_per_day').default(-1),
	previews: integer('previews').default(-1),
	workloadMemoryMb: integer('workload_memory_mb').default(-1),
	egressBytes: integer('egress_bytes').default(-1),
	updatedAt: integer('updated_at').notNull().$defaultFn(now),
});

/**
 * Per-project quota overrides (plan 16). Every column is nullable: null inherits the org quota,
 * so an override only has to name what differs. Timestamps are epoch milliseconds.
 */
export const projectQuotas = sqliteTable(
	'project_quotas',
	{
		projectId: text('project_id').primaryKey(),
		orgId: text('org_id').notNull(),
		projects: integer('projects'),
		storageBytes: integer('storage_bytes'),
		retainedDeployments: integer('retained_deployments'),
		maxUploadBytes: integer('max_upload_bytes'),
		databases: integer('databases'),
		databaseStorageBytes: integer('database_storage_bytes'),
		storageInstances: integer('storage_instances'),
		storageObjects: integer('storage_objects'),
		appVolumes: integer('app_volumes'),
		appVolumeBytes: integer('app_volume_bytes'),
		jobs: integer('jobs'),
		jobRunsPerDay: integer('job_runs_per_day'),
		buildsPerDay: integer('builds_per_day'),
		previews: integer('previews'),
		workloadMemoryMb: integer('workload_memory_mb'),
		egressBytes: integer('egress_bytes'),
		updatedAt: integer('updated_at').notNull().$defaultFn(now),
	},
	(t) => [index('project_quotas_org_idx').on(t.orgId)],
);

/**
 * One usage snapshot per org/project and UTC day (plan 16). `project_id` is an empty string for
 * the org roll-up so the composite primary key works in SQLite (NULLs are distinct in a key).
 */
export const usageSnapshots = sqliteTable(
	'usage_snapshots',
	{
		orgId: text('org_id').notNull(),
		projectId: text('project_id').notNull().default(''),
		day: text('day').notNull(),
		metricsJson: text('metrics_json').notNull(),
		createdAt: integer('created_at').notNull().$defaultFn(now),
	},
	(t) => [primaryKey({ columns: [t.orgId, t.projectId, t.day] })],
);

export const orgKeys = sqliteTable('org_keys', {
	orgId: text('org_id').primaryKey(),
	/** Envelope-encrypted data key (base64), wrapped by the platform master key. */
	wrappedKey: text('wrapped_key').notNull(),
	createdAt: integer('created_at').notNull().$defaultFn(now),
});

export const secrets = sqliteTable(
	'secrets',
	{
		id: text('id').primaryKey(),
		orgId: text('org_id').notNull(),
		projectId: text('project_id'),
		name: text('name').notNull(),
		type: text('type', { enum: ['secret', 'env'] }).notNull().default('secret'),
		version: integer('version').notNull().default(1),
		/** Envelope-encrypted value; never selected by the read APIs. */
		ciphertext: text('ciphertext').notNull(),
		nonce: text('nonce').notNull(),
		createdBy: text('created_by').notNull(),
		createdAt: integer('created_at').notNull().$defaultFn(now),
		deletedAt: integer('deleted_at'),
	},
	(t) => [uniqueIndex('secrets_scope_name_idx').on(t.orgId, t.projectId, t.name, t.version)],
);

export const settings = sqliteTable('settings', {
	key: text('key').primaryKey(),
	value: text('value').notNull(),
	updatedAt: integer('updated_at').notNull().$defaultFn(now),
});

export const backupRuns = sqliteTable('backup_runs', {
	id: text('id').primaryKey(),
	kind: text('kind', { enum: ['backup', 'restore-drill'] }).notNull(),
	status: text('status', { enum: ['running', 'ok', 'failed'] }).notNull(),
	detail: text('detail'),
	startedAt: integer('started_at').notNull().$defaultFn(now),
	finishedAt: integer('finished_at'),
});

export const alertState = sqliteTable('alert_state', {
	key: text('key').primaryKey(),
	lastFiredAt: integer('last_fired_at'),
	lastValue: text('last_value'),
});

// ---------------------------------------------------------------------------
// Append-only migration blocks: new tables go below this line, in migration
// order, so rebases do not churn existing definitions.
// ---------------------------------------------------------------------------

/**
 * Generic durable scheduler (docs/SCHEDULER.md, F4). Feature code supplies the meaning of `kind`
 * and `key`; the service only stores, leases, retries and completes work. `kind + key` is unique
 * so enqueueing the same work twice is a no-op while it is queued or leased.
 */
export const scheduledTasks = sqliteTable(
	'scheduled_tasks',
	{
		id: text('id').primaryKey(),
		kind: text('kind').notNull(),
		key: text('key').notNull(),
		/** Epoch ms; claimable once `run_at <= now`. */
		runAt: integer('run_at').notNull(),
		leaseUntil: integer('lease_until'),
		attempts: integer('attempts').notNull().default(0),
		maxAttempts: integer('max_attempts').notNull().default(5),
		payloadJson: text('payload_json'),
		status: text('status', { enum: ['queued', 'leased', 'ok', 'failed', 'cancelled'] })
			.notNull()
			.default('queued'),
		resultJson: text('result_json'),
		lastError: text('last_error'),
		createdAt: integer('created_at').notNull().$defaultFn(now),
		updatedAt: integer('updated_at').notNull().$defaultFn(now),
	},
	(t) => [
		uniqueIndex('scheduled_tasks_kind_key_idx').on(t.kind, t.key),
		index('scheduled_tasks_due_idx').on(t.status, t.runAt),
		index('scheduled_tasks_lease_idx').on(t.status, t.leaseUntil),
	],
);

/**
 * Point-in-time recovery state for one managed database (docs/PITR.md). The repository secrets are
 * deliberately absent: the node fetches them from the agent activation endpoint and the helper
 * writes a 0400 pgBackRest config. `repoJson` is safe to render in views.
 */
export const databasePitr = sqliteTable(
	'database_pitr',
	{
		databaseId: text('database_id').primaryKey(),
		orgId: text('org_id').notNull(),
		enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
		stanza: text('stanza').notNull(),
		repoJson: text('repo_json').notNull(),
		status: text('status', { enum: ['pending', 'ok', 'failed', 'paused'] })
			.notNull()
			.default('pending'),
		archiveStatus: text('archive_status', { enum: ['ok', 'failing', 'unknown'] }),
		archiveAt: integer('archive_at'),
		lastBaseBackupAt: integer('last_base_backup_at'),
		lastBaseBackupType: text('last_base_backup_type', { enum: ['full', 'diff', 'incr'] }),
		nextFullAt: integer('next_full_at'),
		nextDiffAt: integer('next_diff_at'),
		lastRestoreTargetAt: integer('last_restore_target_at'),
		lastRestoreDatabaseId: text('last_restore_database_id'),
		verifiedAt: integer('verified_at'),
		error: text('error'),
		/** Recoverable window reported by the node's status task (0070); epoch ms. */
		recoverableFromAt: integer('recoverable_from_at'),
		recoverableToAt: integer('recoverable_to_at'),
		windowCheckedAt: integer('window_checked_at'),
		createdAt: integer('created_at').notNull().$defaultFn(now),
		updatedAt: integer('updated_at').notNull().$defaultFn(now),
	},
	(t) => [index('database_pitr_status_idx').on(t.status)],
);

/** One base-backup, status or restore request handed to a database's node. */
export const databasePitrTasks = sqliteTable(
	'database_pitr_tasks',
	{
		id: text('id').primaryKey(),
		orgId: text('org_id').notNull(),
		databaseId: text('database_id').notNull(),
		targetDatabaseId: text('target_database_id'),
		action: text('action', { enum: ['basebackup', 'restore', 'status'] }).notNull(),
		status: text('status', { enum: ['pending', 'running', 'ok', 'failed'] })
			.notNull()
			.default('pending'),
		baseBackupType: text('base_backup_type', { enum: ['full', 'diff', 'incr'] }),
		targetTime: integer('target_time'),
		createdBy: text('created_by').notNull(),
		createdAt: integer('created_at').notNull().$defaultFn(now),
		startedAt: integer('started_at'),
		finishedAt: integer('finished_at'),
		error: text('error'),
	},
	(t) => [
		index('database_pitr_tasks_pending_idx').on(t.status, t.createdAt),
		index('database_pitr_tasks_database_idx').on(t.databaseId, t.createdAt),
	],
);

/**
 * GitHub runners registered through a JIT config (plan 21). Lets the control plane remove a
 * replica's previous registration when it mints the next one; no credential is stored.
 */
export const githubRunnerRegistrations = sqliteTable(
	'github_runner_registrations',
	{
		id: text('id').primaryKey(),
		orgId: text('org_id').notNull(),
		projectId: text('project_id').notNull(),
		workloadId: text('workload_id').notNull(),
		replica: integer('replica').notNull(),
		runnerId: integer('runner_id').notNull(),
		runnerName: text('runner_name').notNull(),
		/** `owner/repo` or `owner` (org scope) at registration time. */
		target: text('target').notNull(),
		createdAt: integer('created_at').notNull().$defaultFn(now),
	},
	(t) => [
		index('github_runner_registrations_workload_idx').on(t.workloadId, t.replica),
		index('github_runner_registrations_project_idx').on(t.projectId),
	],
);

/**
 * Native database studio sessions (plan 22, D96). One open row per (database, user); the token is
 * sealed with the org key and only opened for the session's own endpoint and the node activation.
 */
export const databaseStudioSessions = sqliteTable(
	'database_studio_sessions',
	{
		id: text('id').primaryKey(),
		databaseId: text('database_id').notNull(),
		orgId: text('org_id').notNull(),
		nodeId: text('node_id').notNull(),
		userId: text('user_id').notNull(),
		tokenSealed: text('token_sealed').notNull(),
		readOnly: integer('read_only', { mode: 'boolean' }).notNull().default(true),
		expiresAt: integer('expires_at').notNull(),
		idleMs: integer('idle_ms').notNull(),
		lastUsedAt: integer('last_used_at').notNull(),
		createdAt: integer('created_at').notNull().$defaultFn(now),
		closedAt: integer('closed_at'),
		/** `closed`, `mode-change`, `expired`, `idle` or `deleted`. */
		closeReason: text('close_reason'),
	},
	(t) => [
		index('database_studio_sessions_user_idx').on(t.databaseId, t.userId),
		index('database_studio_sessions_node_idx').on(t.nodeId),
	],
);

/**
 * A managed database moving to another node (D97). The database row is re-pointed at the target
 * once the final dump is in the ObjectStore; this row keeps the source placement for rollback and
 * names the node whose copy still has to be purged.
 */
export const databaseMoves = sqliteTable(
	'database_moves',
	{
		id: text('id').primaryKey(),
		orgId: text('org_id').notNull(),
		databaseId: text('database_id').notNull(),
		sourceNodeId: text('source_node_id').notNull(),
		targetNodeId: text('target_node_id').notNull(),
		sourceHostPort: integer('source_host_port').notNull(),
		sourcePoolerPort: integer('source_pooler_port'),
		sourceVolumeId: text('source_volume_id'),
		targetVolumeId: text('target_volume_id'),
		/** `dump` (final backup of a running database), `latest-backup` or `empty` (for one that cannot run). */
		dataSource: text('data_source', { enum: ['dump', 'latest-backup', 'empty'] })
			.notNull()
			.default('dump'),
		phase: text('phase', { enum: ['quiescing', 'dumping', 'restoring', 'purging', 'done', 'failed'] })
			.notNull()
			.default('quiescing'),
		outcome: text('outcome', { enum: ['moved', 'rolled_back'] }),
		backupId: text('backup_id'),
		/** Attached projects stopped for the move and re-pointed at the target with it. */
		projectIdsJson: text('project_ids_json').notNull().default('[]'),
		backupWasEnabled: integer('backup_was_enabled', { mode: 'boolean' }).notNull().default(false),
		/** Desired-state version that stops the attached apps; the dump waits until the source applied it. */
		quiesceVersion: integer('quiesce_version').notNull().default(0),
		/** Node whose copy is purged in the `purging` phase: the source after a move, the target after a rollback. */
		purgeNodeId: text('purge_node_id'),
		error: text('error'),
		createdBy: text('created_by').notNull(),
		createdAt: integer('created_at').notNull().$defaultFn(now),
		updatedAt: integer('updated_at').notNull().$defaultFn(now),
		finishedAt: integer('finished_at'),
	},
	(t) => [
		index('database_moves_database_idx').on(t.databaseId, t.phase),
		index('database_moves_phase_idx').on(t.phase),
	],
);

// --- Email (docs/EMAIL.md, D114–D120, migration 0050) -----------------------------------------

/** Per-org sending state and limits (EMAIL.md §7.3). */
export const emailOrgs = sqliteTable('email_orgs', {
	orgId: text('org_id').primaryKey(),
	state: text('state', { enum: ['sandbox', 'active', 'paused'] }).notNull().default('sandbox'),
	perSecond: integer('per_second').notNull().default(1),
	perDay: integer('per_day').notNull().default(200),
	pausedReason: text('paused_reason'),
	updatedAt: integer('updated_at').notNull().$defaultFn(now),
});

/** Sending/receiving identities; the DKIM private key is sealed with the org data key (D116). */
export const emailDomains = sqliteTable(
	'email_domains',
	{
		id: text('id').primaryKey(),
		orgId: text('org_id').notNull(),
		name: text('name').notNull(),
		sending: integer('sending', { mode: 'boolean' }).notNull().default(true),
		receiving: integer('receiving', { mode: 'boolean' }).notNull().default(false),
		status: text('status', { enum: ['pending', 'verified', 'failed'] }).notNull().default('pending'),
		dkimSelector: text('dkim_selector').notNull(),
		/** Base64 SPKI, as published in the DKIM TXT record. */
		dkimPublic: text('dkim_public').notNull(),
		dkimPrivateSealed: text('dkim_private_sealed').notNull(),
		/** EmailRecordCheck[] from the last check. */
		recordsJson: text('records_json').notNull().default('[]'),
		/** purpose → Cloudflare record id, for records Skiff created. */
		managedJson: text('managed_json').notNull().default('{}'),
		lastCheckedAt: integer('last_checked_at'),
		verifiedAt: integer('verified_at'),
		failingSince: integer('failing_since'),
		createdBy: text('created_by').notNull(),
		createdAt: integer('created_at').notNull().$defaultFn(now),
		updatedAt: integer('updated_at').notNull().$defaultFn(now),
	},
	(t) => [uniqueIndex('email_domains_name_idx').on(t.name), index('email_domains_org_idx').on(t.orgId)],
);

/** Verified single addresses (sandbox recipients, forward targets). */
export const emailAddresses = sqliteTable(
	'email_addresses',
	{
		id: text('id').primaryKey(),
		orgId: text('org_id').notNull(),
		address: text('address').notNull(),
		tokenHash: text('token_hash'),
		verifiedAt: integer('verified_at'),
		createdBy: text('created_by').notNull(),
		createdAt: integer('created_at').notNull().$defaultFn(now),
		/** When the last verification link went out; it expires a day later (migration 0066). */
		sentAt: integer('sent_at'),
		/** Verification mails sent for the current token. */
		sendCount: integer('send_count').notNull().default(0),
	},
	(t) => [uniqueIndex('email_addresses_org_address_idx').on(t.orgId, t.address)],
);

/** An org owner's request to leave the sandbox; a platform admin decides (EMAIL.md §7.3, migration 0066). */
export const emailAccessRequests = sqliteTable(
	'email_access_requests',
	{
		id: text('id').primaryKey(),
		orgId: text('org_id').notNull(),
		status: text('status', { enum: ['pending', 'approved', 'denied'] }).notNull().default('pending'),
		useCase: text('use_case').notNull(),
		expectedDailyVolume: integer('expected_daily_volume').notNull(),
		website: text('website'),
		requestedBy: text('requested_by').notNull(),
		requesterEmail: text('requester_email'),
		decidedBy: text('decided_by'),
		decidedAt: integer('decided_at'),
		decisionNote: text('decision_note'),
		grantedPerDay: integer('granted_per_day'),
		grantedPerSecond: integer('granted_per_second'),
		createdAt: integer('created_at').notNull().$defaultFn(now),
		updatedAt: integer('updated_at').notNull().$defaultFn(now),
	},
	(t) => [
		index('email_access_requests_org_idx').on(t.orgId, t.createdAt),
		index('email_access_requests_status_idx').on(t.status, t.createdAt),
	],
);

/** SMTP/API credentials; `envPrefix` marks a project attachment (EMAIL.md §5.4). */
export const emailCredentials = sqliteTable(
	'email_credentials',
	{
		id: text('id').primaryKey(),
		orgId: text('org_id').notNull(),
		projectId: text('project_id'),
		name: text('name').notNull(),
		username: text('username').notNull(),
		hash: text('hash').notNull(),
		secretSealed: text('secret_sealed').notNull(),
		allowedFromJson: text('allowed_from_json').notNull().default('[]'),
		envPrefix: text('env_prefix'),
		lastUsedAt: integer('last_used_at'),
		createdBy: text('created_by').notNull(),
		createdAt: integer('created_at').notNull().$defaultFn(now),
		revokedAt: integer('revoked_at'),
	},
	(t) => [uniqueIndex('email_credentials_username_idx').on(t.username), index('email_credentials_org_idx').on(t.orgId)],
);

/** REST and binding sends waiting for the mail node (D117). */
export const emailOutbox = sqliteTable(
	'email_outbox',
	{
		messageId: text('message_id').primaryKey(),
		orgId: text('org_id').notNull(),
		payloadJson: text('payload_json').notNull(),
		createdAt: integer('created_at').notNull().$defaultFn(now),
		claimedAt: integer('claimed_at'),
	},
	(t) => [index('email_outbox_created_idx').on(t.createdAt)],
);

/** The message log (D120). */
export const emailMessages = sqliteTable(
	'email_messages',
	{
		id: text('id').primaryKey(),
		orgId: text('org_id').notNull(),
		projectId: text('project_id'),
		source: text('source', { enum: ['api', 'smtp', 'binding'] }).notNull(),
		fromAddress: text('from_address').notNull(),
		subject: text('subject').notNull().default(''),
		tagsJson: text('tags_json').notNull().default('{}'),
		status: text('status').notNull().default('accepted'),
		idempotencyKey: text('idempotency_key'),
		createdAt: integer('created_at').notNull().$defaultFn(now),
		updatedAt: integer('updated_at').notNull().$defaultFn(now),
	},
	(t) => [index('email_messages_org_created_idx').on(t.orgId, t.createdAt)],
);

export const emailRecipients = sqliteTable(
	'email_recipients',
	{
		messageId: text('message_id').notNull(),
		idx: integer('idx').notNull(),
		orgId: text('org_id').notNull(),
		address: text('address').notNull(),
		status: text('status').notNull().default('accepted'),
		bounceClass: text('bounce_class'),
		lastResponse: text('last_response'),
		hardBounced: integer('hard_bounced', { mode: 'boolean' }).notNull().default(false),
		complained: integer('complained', { mode: 'boolean' }).notNull().default(false),
		createdAt: integer('created_at').notNull().$defaultFn(now),
		updatedAt: integer('updated_at').notNull().$defaultFn(now),
	},
	(t) => [
		primaryKey({ columns: [t.messageId, t.idx] }),
		index('email_recipients_org_created_idx').on(t.orgId, t.createdAt),
		index('email_recipients_address_idx').on(t.orgId, t.address),
	],
);

/** Suppression lists (D119); `orgId = '*'` is the platform-wide list. */
export const emailSuppressions = sqliteTable(
	'email_suppressions',
	{
		orgId: text('org_id').notNull(),
		address: text('address').notNull(),
		reason: text('reason', { enum: ['bounce', 'complaint', 'manual', 'unsubscribe'] }).notNull(),
		messageId: text('message_id'),
		createdAt: integer('created_at').notNull().$defaultFn(now),
		expiresAt: integer('expires_at'),
	},
	(t) => [primaryKey({ columns: [t.orgId, t.address] })],
);

/** Every table worth exporting, for tooling and tests. */
export const schema = {
	nodes,
	nodeJoinTokens,
	projects,
	slugRedirects,
	uploadSessions,
	releases,
	configSnapshots,
	deployments,
	shareLinks,
	shareRedemptions,
	domains,
	environments,
	workloads,
	gitSources,
	builds,
	logEvents,
	jobs,
	jobRuns,
	auditLog,
	orgQuotas,
	projectQuotas,
	usageSnapshots,
	orgKeys,
	secrets,
	settings,
	backupRuns,
	alertState,
	databaseBackups,
	backupTargets,
	databasePitr,
	databasePitrTasks,
	scheduledTasks,
	githubRunnerRegistrations,
	databaseStudioSessions,
	databaseMoves,
};

export { primaryKey };
