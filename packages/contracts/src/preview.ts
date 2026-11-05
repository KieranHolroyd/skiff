import * as z from 'zod';
import { accessModes } from './model.ts';
import { bucketNameSchema } from './object-storage.ts';
import { SLUG_PATTERN } from './slugs.ts';

/**
 * Preview environments with cloned or seeded data (plan 12, docs/PREVIEWS.md).
 *
 * A preview is a short-lived environment: a workload per service, an optional database clone,
 * an optional bucket/prefix, a route and a TTL. Data mode is ordered by safety:
 *
 * - `none`  — no database (static sites);
 * - `schema-seed` (blueprint default) — schema only plus the project's seed command;
 * - `fork`  — a restore of the latest backup, permissioned and never for fork PRs.
 *
 * Clone credentials are minted by the agent and injected through activation; they never appear
 * in a preview view. Teardown is idempotent: the reconciler may run after a missed webhook.
 */

export const previewDataModes = ['none', 'schema-seed', 'fork'] as const;
export type PreviewDataMode = (typeof previewDataModes)[number];

export const previewSources = ['github', 'api', 'cli'] as const;
export type PreviewSource = (typeof previewSources)[number];

export const previewStatuses = ['creating', 'ready', 'failed', 'deleting'] as const;
export type PreviewStatus = (typeof previewStatuses)[number];

export const previewBucketModes = ['none', 'prefix', 'bucket'] as const;
export type PreviewBucketMode = (typeof previewBucketModes)[number];

export const previewLimits = {
	defaultTtlHours: 72,
	maxTtlHours: 720,
	defaultMaxConcurrent: 3,
	maxConcurrentLimit: 50,
} as const;

/** 1 hour … 30 days. The service also caps concurrency against the org quota (plan 16). */
export const previewTtlHoursValueSchema = z.number().int().min(1).max(previewLimits.maxTtlHours);

export const previewTtlHoursSchema = previewTtlHoursValueSchema.default(previewLimits.defaultTtlHours);

export const previewHostSchema = z
	.string()
	.trim()
	.min(4)
	.max(253)
	.transform((value) => value.toLowerCase().replace(/\.$/, ''))
	.refine(
		(value) => /^(?!-)[a-z0-9-]{1,63}(?:\.(?!-)[a-z0-9-]{1,63})+$/.test(value),
		'Enter a hostname like app.example.com (no scheme, port or path).',
	);

/** The `previews:` block in a blueprint; strict so a typo is a plan error, not a silent default. */
export const previewPolicySchema = z
	.strictObject({
		enabled: z.boolean().default(false),
		data: z.enum(previewDataModes).default('schema-seed'),
		ttlHours: previewTtlHoursSchema,
		maxConcurrent: z.number().int().min(1).max(previewLimits.maxConcurrentLimit).default(previewLimits.defaultMaxConcurrent),
	})
	.describe('Preview policy from skiff.yaml.');
export type PreviewPolicy = z.input<typeof previewPolicySchema>;

/**
 * Create a preview. A GitHub-sourced preview must carry the repo and PR number; a data-bearing
 * preview must name its source database; a fork PR can never request `fork` data.
 */
export const previewCreateSchema = z
	.strictObject({
		project: z.string().regex(SLUG_PATTERN, 'Use a project slug.').optional(),
		source: z.enum(previewSources).default('api'),
		/** `owner/name` for GitHub previews. */
		repo: z
			.string()
			.trim()
			.min(3)
			.max(200)
			.regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'Use owner/name.')
			.optional(),
		prNumber: z.number().int().positive().max(1_000_000).optional(),
		headSha: z
			.string()
			.regex(/^[a-f0-9]{7,64}$/, 'Use a lowercase hex commit SHA.')
			.optional(),
		baseBranch: z.string().trim().min(1).max(200).optional(),
		/** Set by the webhook handler; a fork PR is untrusted code and cannot fork production data. */
		fromFork: z.boolean().default(false),
		dataMode: z.enum(previewDataModes).default('none'),
		/** Source database name for `schema-seed`/`fork`. */
		database: z.string().min(1).max(100).optional(),
		/** Storage instance that provides the preview bucket/prefix. */
		storage: z.string().min(1).max(100).optional(),
		/** Existing bucket to isolate by prefix; omitted chooses the instance default. */
		bucket: bucketNameSchema.optional(),
		/** `none` for a static preview; prefix/bucket require a storage instance. */
		bucketMode: z.enum(previewBucketModes).default('none'),
		ttlHours: previewTtlHoursSchema,
		/** Previews are protected by default; public is an explicit, warned choice. */
		access: z.enum(accessModes).default('platform'),
		/** Pin a deployment instead of building the PR head. */
		deploymentId: z.string().min(1).max(100).optional(),
	})
	.superRefine((input, ctx) => {
		if (input.source === 'github' && (!input.repo || !input.prNumber))
			ctx.addIssue({ code: 'custom', path: ['repo'], message: 'A GitHub preview needs a repo and a PR number.' });
		if (input.dataMode !== 'none' && !input.database)
			ctx.addIssue({ code: 'custom', path: ['database'], message: `Data mode "${input.dataMode}" needs a source database.` });
		if (input.dataMode === 'fork' && input.fromFork)
			ctx.addIssue({ code: 'custom', path: ['dataMode'], message: 'Fork PRs cannot clone production data.' });
		if (input.bucketMode !== 'none' && !input.storage)
			ctx.addIssue({ code: 'custom', path: ['storage'], message: `Bucket mode "${input.bucketMode}" needs a storage instance.` });
	});
export type PreviewCreate = z.input<typeof previewCreateSchema>;

export const previewUpdateSchema = z
	.strictObject({
		ttlHours: previewTtlHoursValueSchema.optional(),
		access: z.enum(accessModes).optional(),
	})
	.refine((input) => Object.keys(input).length > 0, 'Nothing to update.');
export type PreviewUpdate = z.infer<typeof previewUpdateSchema>;

// -------------------------------------------------------------------- database clone

export const previewCloneModes = ['schema-seed', 'fork'] as const;
export type PreviewCloneMode = (typeof previewCloneModes)[number];

export const previewCloneStatuses = ['pending', 'creating', 'ready', 'deleting', 'failed'] as const;
export type PreviewCloneStatus = (typeof previewCloneStatuses)[number];

/** Postgres database/role identifiers the agent creates inside the source instance. */
export const previewCloneNameSchema = z
	.string()
	.min(3)
	.max(63)
	.regex(/^[a-z][a-z0-9_]*$/, 'Use lowercase letters, digits and underscores, starting with a letter.');

export const previewDatabaseCloneCreateSchema = z
	.strictObject({
		sourceDatabaseId: z.string().min(1).max(100),
		mode: z.enum(previewCloneModes),
		/** Clone database name; derived from the preview when omitted. */
		databaseName: previewCloneNameSchema.optional(),
		/** Scoped role granted only this clone; derived when omitted. */
		role: previewCloneNameSchema.optional(),
		/** Latest verified artifact, required for fork mode. */
		sourceArtifactId: z.string().min(1).max(100).optional(),
	})
	.superRefine((input, ctx) => {
		if (input.mode === 'fork' && !input.sourceArtifactId)
			ctx.addIssue({ code: 'custom', path: ['sourceArtifactId'], message: 'Fork mode needs a verified backup artifact.' });
	});
export type PreviewDatabaseCloneCreate = z.input<typeof previewDatabaseCloneCreateSchema>;

export const previewDatabaseCloneViewSchema = z.strictObject({
	id: z.string(),
	previewId: z.string(),
	sourceDatabaseId: z.string(),
	sourceDatabaseName: z.string(),
	databaseName: z.string(),
	role: z.string(),
	mode: z.enum(previewCloneModes),
	sourceArtifactId: z.string().nullable(),
	status: z.enum(previewCloneStatuses),
	error: z.string().max(2000).nullable(),
	expiresAt: z.string().nullable(),
	createdAt: z.string(),
});
export type PreviewDatabaseCloneView = z.infer<typeof previewDatabaseCloneViewSchema>;

// -------------------------------------------------------------------- bucket isolation

export const previewBucketPrefixSchema = z
	.string()
	.trim()
	.min(1)
	.max(900)
	.refine((value) => !value.startsWith('/'), 'A preview prefix is relative to the bucket.')
	.refine((value) => value.endsWith('/'), 'A preview prefix ends with "/".')
	.refine(
		(value) => value.split('/').slice(0, -1).every((part) => part !== '' && part !== '.' && part !== '..'),
		'A preview prefix cannot contain empty, "." or ".." segments.',
	);

/** The isolated bucket or prefix a preview owns. The scoped key id is not secret. */
export const previewBucketViewSchema = z.strictObject({
	storageId: z.string(),
	storageName: z.string(),
	bucket: z.string(),
	mode: z.enum(['prefix', 'bucket']),
	/** Empty for a dedicated bucket. */
	prefix: z.string(),
	/** Access key id only (the secret is injected through activation). */
	scopedKeyId: z.string().nullable(),
});
export type PreviewBucketView = z.infer<typeof previewBucketViewSchema>;

// -------------------------------------------------------------------- view

export const previewViewSchema = z.strictObject({
	id: z.string(),
	projectId: z.string(),
	projectSlug: z.string(),
	environmentId: z.string(),
	environmentSlug: z.string(),
	host: z.string(),
	source: z.enum(previewSources),
	status: z.enum(previewStatuses),
	url: z.string().nullable(),
	repo: z.string().nullable(),
	prNumber: z.number().int().positive().nullable(),
	headSha: z.string().nullable(),
	baseBranch: z.string().nullable(),
	dataMode: z.enum(previewDataModes),
	databaseClone: previewDatabaseCloneViewSchema.nullable(),
	bucket: previewBucketViewSchema.nullable(),
	access: z.enum(accessModes),
	ttlHours: z.number().int().positive(),
	expiresAt: z.string().nullable(),
	createdAt: z.string(),
	teardownAt: z.string().nullable(),
	error: z.string().max(2000).nullable(),
});
export type PreviewView = z.infer<typeof previewViewSchema>;

/** `GET /projects/:slug/previews`: current previews plus the project's policy. */
export const previewListViewSchema = z.strictObject({
	projectId: z.string(),
	projectSlug: z.string(),
	policy: previewPolicySchema,
	previews: z.array(previewViewSchema).max(200),
});
export type PreviewListView = z.infer<typeof previewListViewSchema>;
