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
		createdAt: integer('created_at').notNull().$defaultFn(now),
		updatedAt: integer('updated_at').notNull().$defaultFn(now),
	},
	(t) => [index('nodes_status_idx').on(t.status)],
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
		/** `edge`, `auto`, or a specific node id. */
		placement: text('placement').notNull().default('edge'),
		productionDeploymentId: text('production_deployment_id'),
		productionAccess: text('production_access', { enum: ['public', 'password', 'platform'] })
			.notNull()
			.default('public'),
		previewAccess: text('preview_access', { enum: ['public', 'password', 'platform'] })
			.notNull()
			.default('platform'),
		/** Hashed access password for `password` mode (scrypt). Never returned by the API. */
		accessSecretHash: text('access_secret_hash'),
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
		status: text('status', { enum: ['pending', 'starting', 'running', 'failed', 'stopped'] })
			.notNull()
			.default('pending'),
		/** Validated WorkloadSpec (no secret values). */
		specJson: text('spec_json').notNull(),
		memoryMb: integer('memory_mb').notNull(),
		cpus: integer('cpus').notNull().default(1),
		upstream: text('upstream'),
		message: text('message'),
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
		engine: text('engine', { enum: ['postgres'] }).notNull().default('postgres'),
		version: text('version').notNull(),
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
 * Managed database backups (docs/DATABASES.md §9). The dump itself lives in the platform
 * `ObjectStore`; this row is only the index/metadata. `sha256` is computed by the node while it
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
	},
	(t) => [
		index('database_backups_database_idx').on(t.databaseId, t.createdAt),
		index('database_backups_status_idx').on(t.status),
		index('database_backups_expires_idx').on(t.expiresAt),
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
	},
	(t) => [
		uniqueIndex('storage_instances_org_name_idx').on(t.orgId, t.name),
		uniqueIndex('storage_instances_node_port_idx').on(t.nodeId, t.hostPort),
		uniqueIndex('storage_instances_public_host_idx').on(t.publicHost),
		index('storage_instances_node_idx').on(t.nodeId),
		index('storage_instances_deleted_idx').on(t.deletedAt),
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
	},
	(t) => [
		index('log_events_project_seq_idx').on(t.projectId, t.seq),
		index('log_events_deployment_seq_idx').on(t.deploymentId, t.seq),
		index('log_events_build_seq_idx').on(t.buildId, t.seq),
		index('log_events_ts_idx').on(t.ts),
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

export const orgQuotas = sqliteTable('org_quotas', {
	orgId: text('org_id').primaryKey(),
	/** -1 means unlimited (owner org). */
	projects: integer('projects').notNull().default(-1),
	storageBytes: integer('storage_bytes').notNull().default(-1),
	retainedDeployments: integer('retained_deployments').notNull().default(-1),
	maxUploadBytes: integer('max_upload_bytes').notNull().default(-1),
	updatedAt: integer('updated_at').notNull().$defaultFn(now),
});

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
	auditLog,
	orgQuotas,
	orgKeys,
	secrets,
	settings,
	backupRuns,
	alertState,
	databaseBackups,
	scheduledTasks,
};

export { primaryKey };
