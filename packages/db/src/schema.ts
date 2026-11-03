import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

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
		runtime: text('runtime', { enum: ['static', 'process', 'container'] })
			.notNull()
			.default('static'),
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
		deletedAt: integer('deleted_at'),
	},
	(t) => [
		uniqueIndex('deployments_short_idx').on(t.shortId),
		index('deployments_project_idx').on(t.projectId),
		index('deployments_status_idx').on(t.status),
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
		status: text('status', { enum: ['pending', 'verified', 'active', 'failed'] })
			.notNull()
			.default('pending'),
		verificationToken: text('verification_token'),
		verifiedAt: integer('verified_at'),
		createdAt: integer('created_at').notNull().$defaultFn(now),
	},
	(t) => [uniqueIndex('domains_host_idx').on(t.hostname), index('domains_project_idx').on(t.projectId)],
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
		createdAt: integer('created_at').notNull().$defaultFn(now),
	},
	(t) => [
		index('audit_org_idx').on(t.orgId),
		index('audit_created_idx').on(t.createdAt),
		index('audit_action_idx').on(t.action),
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
	auditLog,
	orgQuotas,
	orgKeys,
	secrets,
	settings,
	backupRuns,
	alertState,
};

export { primaryKey };
