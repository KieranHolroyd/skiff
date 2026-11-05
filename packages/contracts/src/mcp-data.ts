import * as z from 'zod';
import { blueprintApplyViewSchema, blueprintPlanViewSchema, blueprintProjectSchema } from './blueprint.ts';
import { databaseBackupStatuses, DATABASE_BACKUP_FORMAT } from './database-backup.ts';
import { databaseNameSchema } from './database.ts';
import { bucketNameSchema, storageObjectKeySchema } from './object-storage.ts';
import { previewCloneStatuses } from './preview.ts';
import { quotaUsageViewSchema } from './quota.ts';

/**
 * MCP data tools (plan 20, docs/MCP.md).
 *
 * These are the tool-shaped inputs and outputs an agent sees — not a mirror of the REST API.
 * Every output is shaped to be small and safe: no credentials, no raw row dumps beyond the row
 * limit, no object lock keys. Destructive calls carry a server-issued confirmation token; the
 * schema requires the token for apply/restore, and the server additionally binds it to the
 * principal, tool, resource, arguments hash and a short expiry.
 *
 * Durable work returns a `taskId` polled with `get_task`; older MCP clients can use the
 * synchronous fallback the service provides.
 */

export const mcpDataToolNames = [
	'plan_stack',
	'apply_stack',
	'get_data_health',
	'query_database',
	'create_presigned_url',
	'list_backups',
	'restore_backup',
	'fork_database',
	'get_task',
] as const;
export type McpDataToolName = (typeof mcpDataToolNames)[number];

export const mcpTaskStatuses = ['queued', 'running', 'input_required', 'succeeded', 'failed', 'expired', 'cancelled'] as const;
export type McpTaskStatus = (typeof mcpTaskStatuses)[number];

const confirmationTokenSchema = z.string().min(20).max(200);

// -------------------------------------------------------------------- JSON

export type McpJsonValue = string | number | boolean | null | McpJsonValue[] | { [key: string]: McpJsonValue };

export const mcpJsonValueSchema: z.ZodType<McpJsonValue> = z.lazy(() =>
	z.union([
		z.string(),
		z.number(),
		z.boolean(),
		z.null(),
		z.array(mcpJsonValueSchema),
		z.record(z.string(), mcpJsonValueSchema),
	]),
);

// -------------------------------------------------------------------- plan_stack

/**
 * Plan a blueprint. Supply exactly one of the YAML document or a server-local path; a path is
 * confined to the configured blueprint directory (the service, not the schema, enforces that).
 */
export const planStackInputSchema = z
	.strictObject({
		project: blueprintProjectSchema.optional(),
		blueprint: z.string().min(1).max(1_000_000).optional(),
		path: z.string().min(1).max(1000).optional(),
	})
	.superRefine((input, ctx) => {
		if (Boolean(input.blueprint) === Boolean(input.path))
			ctx.addIssue({ code: 'custom', message: 'Supply exactly one of `blueprint` or `path`.' });
	});
export type PlanStackInput = z.infer<typeof planStackInputSchema>;

export const planStackOutputSchema = blueprintPlanViewSchema;
export type PlanStackOutput = z.infer<typeof planStackOutputSchema>;

// -------------------------------------------------------------------- apply_stack

/** Apply a plan hash. The confirmation token is single-use and bound to the arguments hash. */
export const applyStackInputSchema = z.strictObject({
	project: blueprintProjectSchema.optional(),
	planHash: z.string().regex(/^[a-f0-9]{64}$/, 'Use the plan hash returned by plan_stack.'),
	/** Delete resources absent from the document; requires a second confirmation in the UI. */
	prune: z.boolean().default(false),
	confirmationToken: confirmationTokenSchema,
});
export type ApplyStackInput = z.infer<typeof applyStackInputSchema>;

export const applyStackOutputSchema = blueprintApplyViewSchema;
export type ApplyStackOutput = z.infer<typeof applyStackOutputSchema>;

// -------------------------------------------------------------------- get_data_health

export const dataHealthCheckSchema = z.strictObject({
	name: z.string().min(1).max(100),
	status: z.enum(['ok', 'warn', 'fail']),
	message: z.string().max(1000),
});

const databaseHealthSchema = z.strictObject({
	id: z.string(),
	name: z.string(),
	engine: z.string(),
	status: z.string(),
	sizeBytes: z.number().int().nonnegative().nullable(),
	connections: z.strictObject({ active: z.number().int().nonnegative(), max: z.number().int().nonnegative() }),
	pooler: z.strictObject({ enabled: z.boolean(), saturated: z.boolean().nullable() }),
	tls: z.strictObject({ enabled: z.boolean(), expiresAt: z.string().nullable() }),
	backup: z.strictObject({
		lastBackupAt: z.string().nullable(),
		ageSeconds: z.number().int().nonnegative().nullable(),
		lastStatus: z.enum(databaseBackupStatuses).nullable(),
		lastVerifiedAt: z.string().nullable(),
	}),
	replicaLagSeconds: z.number().nonnegative().nullable(),
});

const storageHealthSchema = z.strictObject({
	id: z.string(),
	name: z.string(),
	status: z.string(),
	usedBytes: z.number().int().nonnegative().nullable(),
	objects: z.number().int().nonnegative().nullable(),
	quotaBytes: z.number().int().nonnegative().nullable(),
	public: z.boolean(),
});

const workloadHealthSchema = z.strictObject({
	id: z.string(),
	status: z.string(),
	memoryMb: z.number().int().positive(),
	restarts: z.number().int().nonnegative(),
	diskFreeBytes: z.number().int().nonnegative().nullable(),
	diskTotalBytes: z.number().int().nonnegative().nullable(),
});

export const getDataHealthInputSchema = z.strictObject({
	project: blueprintProjectSchema,
	/** Database, storage instance or workload name/id; omitted returns a project summary. */
	resource: z.string().min(1).max(100).optional(),
	kind: z.enum(['database', 'storage', 'workload']).optional(),
});
export type GetDataHealthInput = z.infer<typeof getDataHealthInputSchema>;

/** Read-only health summary. Never includes credentials or raw query data. */
export const getDataHealthOutputSchema = z.strictObject({
	project: z.string(),
	generatedAt: z.string(),
	database: databaseHealthSchema.nullable().default(null),
	storage: storageHealthSchema.nullable().default(null),
	workload: workloadHealthSchema.nullable().default(null),
	quota: quotaUsageViewSchema.nullable().default(null),
	checks: z.array(dataHealthCheckSchema).max(100).default([]),
	warnings: z.array(z.string().max(1000)).max(50).default([]),
});
export type GetDataHealthOutput = z.infer<typeof getDataHealthOutputSchema>;

// -------------------------------------------------------------------- query_database

export const queryDatabaseInputSchema = z.strictObject({
	project: blueprintProjectSchema,
	database: databaseNameSchema,
	/** One read-only statement. The service re-checks it and runs in a READ ONLY transaction. */
	sql: z
		.string()
		.trim()
		.min(1)
		.max(20_000)
		.refine(
			(value) => /^(select|with|explain)\b/i.test(value),
			'Only SELECT, WITH and EXPLAIN statements are allowed.',
		)
		.refine((value) => !value.includes('\0'), 'SQL cannot contain NUL bytes.'),
	/** `$1`-style parameters; never interpolate values into `sql`. */
	params: z.array(mcpJsonValueSchema).max(100).default([]),
	maxRows: z.number().int().min(1).max(1000).default(100),
	timeoutMs: z.number().int().min(100).max(30_000).default(5000),
});
export type QueryDatabaseInput = z.input<typeof queryDatabaseInputSchema>;

export const queryDatabaseOutputSchema = z.strictObject({
	columns: z
		.array(
			z.strictObject({
				name: z.string().max(256),
				type: z.string().max(128),
			}),
		)
		.max(200),
	rows: z.array(z.record(z.string(), mcpJsonValueSchema)).max(1000),
	rowCount: z.number().int().nonnegative(),
	truncated: z.boolean(),
	durationMs: z.number().nonnegative(),
	/** Fingerprint of the normalized SQL, for audit correlation; never the raw statement. */
	fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
	readOnly: z.literal(true),
});
export type QueryDatabaseOutput = z.infer<typeof queryDatabaseOutputSchema>;

// -------------------------------------------------------------------- create_presigned_url

export const createPresignedUrlInputSchema = z.strictObject({
	project: blueprintProjectSchema,
	storage: z.string().min(1).max(100),
	bucket: bucketNameSchema,
	key: storageObjectKeySchema,
	method: z.enum(['GET', 'PUT']).default('GET'),
	/** Seconds; S3 caps a presigned URL at seven days. */
	expiresIn: z.number().int().min(60).max(604_800).default(3600),
	/** PUT only: pin the content type the browser may upload. */
	contentType: z.string().min(1).max(200).optional(),
	/** PUT only: pin the maximum object size. */
	sizeBytes: z.number().int().positive().max(5_000_000_000).optional(),
});
export type CreatePresignedUrlInput = z.input<typeof createPresignedUrlInputSchema>;

export const createPresignedUrlOutputSchema = z.strictObject({
	url: z.string().url(),
	method: z.enum(['GET', 'PUT']),
	storage: z.string(),
	bucket: z.string(),
	key: z.string(),
	expiresAt: z.string(),
	/** Null for GET; the pinned limit for PUT. */
	maxBytes: z.number().int().positive().nullable(),
});
export type CreatePresignedUrlOutput = z.infer<typeof createPresignedUrlOutputSchema>;

// -------------------------------------------------------------------- list_backups

export const listBackupsInputSchema = z.strictObject({
	project: blueprintProjectSchema,
	/** Filter to one managed database. */
	database: databaseNameSchema.optional(),
	/** Filter to one backup target by name. */
	target: z.string().min(1).max(40).optional(),
	limit: z.number().int().min(1).max(100).default(20),
});
export type ListBackupsInput = z.input<typeof listBackupsInputSchema>;

/** One artifact summary. No credentials; `objectKey` is not secret but stays scoped to the target. */
export const backupArtifactSchema = z.strictObject({
	id: z.string(),
	databaseId: z.string(),
	databaseName: z.string(),
	kind: z.enum(['manual', 'scheduled']),
	status: z.enum(databaseBackupStatuses),
	format: z.literal(DATABASE_BACKUP_FORMAT),
	sizeBytes: z.number().int().nonnegative().nullable(),
	sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
	objectKey: z.string(),
	pinned: z.boolean(),
	createdAt: z.string(),
	verifiedAt: z.string().nullable(),
	expiresAt: z.string().nullable(),
	target: z.strictObject({ id: z.string(), name: z.string() }).nullable(),
});
export type BackupArtifact = z.infer<typeof backupArtifactSchema>;

export const listBackupsOutputSchema = z.strictObject({
	backups: z.array(backupArtifactSchema).max(100),
	truncated: z.boolean(),
});
export type ListBackupsOutput = z.infer<typeof listBackupsOutputSchema>;

// -------------------------------------------------------------------- restore_backup

/**
 * Restore into a **new** database. In-place restore is a dashboard action with a second human
 * approval; this tool deliberately has no mode for it.
 */
export const restoreBackupInputSchema = z.strictObject({
	project: blueprintProjectSchema,
	backupId: z.string().min(1).max(100),
	targetName: databaseNameSchema,
	mode: z.literal('new').default('new'),
	/** Env prefix for the attachment created on the target project, when requested. */
	envPrefix: z
		.string()
		.min(1)
		.max(64)
		.regex(/^[A-Z][A-Z0-9_]*$/, 'Env prefixes are UPPER_SNAKE_CASE.')
		.refine((value) => !value.endsWith('_'), 'Env prefixes must not end with "_".')
		.optional(),
	confirmationToken: confirmationTokenSchema,
});
export type RestoreBackupInput = z.input<typeof restoreBackupInputSchema>;

export const restoreBackupOutputSchema = z.strictObject({
	taskId: z.string(),
	operationId: z.string().nullable(),
	databaseId: z.string().nullable(),
	status: z.enum(mcpTaskStatuses),
	message: z.string().max(1000).nullable(),
});
export type RestoreBackupOutput = z.infer<typeof restoreBackupOutputSchema>;

// -------------------------------------------------------------------- fork_database

export const forkDatabaseInputSchema = z.strictObject({
	project: blueprintProjectSchema,
	/** Source database name or id. */
	source: z.string().min(1).max(100),
	targetName: databaseNameSchema,
	/** `schema` copies structure only; `data` restores the latest verified backup. */
	mode: z.enum(['schema', 'data']).default('schema'),
	/** Clone lifetime; the service caps it with the preview quota. */
	ttlHours: z.number().int().min(1).max(720).default(24),
	confirmationToken: confirmationTokenSchema.optional(),
});
export type ForkDatabaseInput = z.input<typeof forkDatabaseInputSchema>;

export const forkDatabaseOutputSchema = z.strictObject({
	taskId: z.string(),
	cloneId: z.string(),
	databaseName: z.string(),
	status: z.enum(previewCloneStatuses),
	expiresAt: z.string().nullable(),
});
export type ForkDatabaseOutput = z.infer<typeof forkDatabaseOutputSchema>;

// -------------------------------------------------------------------- get_task

export const getTaskInputSchema = z.strictObject({
	taskId: z.string().min(1).max(120),
});
export type GetTaskInput = z.infer<typeof getTaskInputSchema>;

export const mcpTaskApprovalSchema = z.strictObject({
	required: z.boolean(),
	/** Opaque state the client shows and completes; the server verifies the token, not a boolean. */
	requestState: z.string().max(4000).nullable(),
	expiresAt: z.string().nullable(),
});

/** Poll a durable task. `result` is the tool's output shape when the task succeeds. */
export const getTaskOutputSchema = z.strictObject({
	id: z.string(),
	tool: z.string().max(100),
	status: z.enum(mcpTaskStatuses),
	/** 0–100; null when the tool cannot estimate. */
	progress: z.number().min(0).max(100).nullable(),
	result: mcpJsonValueSchema.nullable(),
	error: z.string().max(2000).nullable(),
	approval: mcpTaskApprovalSchema,
	createdAt: z.string(),
	updatedAt: z.string(),
	expiresAt: z.string().nullable(),
});
export type GetTaskOutput = z.infer<typeof getTaskOutputSchema>;
