import * as z from 'zod';
import { appVolumeBackings, appVolumeMountPathProblem, appVolumeMountPathSchema } from './app-volume.ts';
import { databaseEngineRegistry, databaseEngines, databaseExtensionSchema } from './database.ts';
import { cronSchema } from './database-backup.ts';
import { jobConcurrencyModes } from './job.ts';
import { accessModes } from './model.ts';
import { STORAGE_RESERVED_ENVIRONMENTS, bucketAccesses, bucketNameSchema, storageGrantModes } from './object-storage.ts';
import { operationStatuses } from './operations.ts';
import { previewPolicySchema } from './preview.ts';
import { SLUG_PATTERN } from './slugs.ts';

/**
 * `skiff.yaml` blueprints, version 1 (plan 11, docs/BLUEPRINTS.md).
 *
 * A blueprint is one declarative document for a project: services, databases, storage, jobs,
 * app volumes, domains, env, secret **references**, attachments and preview policy. `skiff plan`
 * diffs it; `skiff apply` runs the diff through the normal service layer. The schema is strict:
 * an unknown field is an error with a precise path, never a silent default.
 *
 * It never contains secret values. `secrets:` names what the plan expects to resolve from the
 * project's secret store; a missing secret is a plan error. Plain `env:` values are visible
 * configuration and should not hold credentials.
 */

export const BLUEPRINT_API_VERSION = 'skiff/v1';
export const blueprintApiVersionSchema = z.literal(BLUEPRINT_API_VERSION);

/** Resource keys are stable identities in the plan (`services.web`, `databases.main`). */
export const blueprintResourceNameSchema = z
	.string()
	.trim()
	.min(1)
	.max(40)
	.regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'Use lowercase letters, digits and single hyphens.')
	.refine((name) => !name.includes('--'), 'Double hyphens are not allowed.');

export const blueprintProjectSchema = z
	.string()
	.regex(SLUG_PATTERN, 'Use a project slug (3–40 lowercase letters, digits and hyphens).');

export const blueprintEnvironmentNameSchema = z
	.string()
	.trim()
	.min(1)
	.max(30)
	.regex(/^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/, 'Environment names are 1–30 lowercase letters, digits and hyphens.')
	.refine((value) => value === 'production' || !value.includes('--'), 'Environment names cannot contain "--".')
	.refine(
		(value) => value === 'production' || !STORAGE_RESERVED_ENVIRONMENTS.has(value),
		'This environment name is reserved for storage endpoints.',
	);

export const blueprintEnvNameSchema = z
	.string()
	.min(1)
	.max(256)
	.regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Env names are letters, digits and underscores, not starting with a digit.');

export const blueprintSecretNameSchema = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[A-Z][A-Z0-9_]*$/, 'Secret names are UPPER_SNAKE_CASE.');

export const blueprintEnvPrefixSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[A-Z][A-Z0-9_]*$/, 'Env prefixes are UPPER_SNAKE_CASE.')
	.refine((value) => !value.endsWith('_'), 'Env prefixes must not end with "_".');

/** Paths in a blueprint are relative to the file and cannot escape the project root. */
export const blueprintRelativePathSchema = z
	.string()
	.trim()
	.min(1)
	.max(400)
	.transform((value) => value.replace(/^\.\//, ''))
	.refine((value) => value.length > 0, 'Use a path relative to skiff.yaml.')
	.refine((value) => !value.startsWith('/'), 'Use a path relative to skiff.yaml.')
	.refine(
		(value) => !value.split('/').some((part) => part === '' || part === '.' || part === '..'),
		'Paths cannot contain empty, "." or ".." segments.',
	);

const staticFileSchema = z
	.string()
	.trim()
	.min(1)
	.max(200)
	.refine((value) => value.startsWith('/'), 'Use a URL path starting with "/".')
	.refine((value) => !value.includes('..'), 'URL paths cannot contain "..".');

export const blueprintHostSchema = z
	.string()
	.trim()
	.min(4)
	.max(253)
	.transform((value) => value.toLowerCase().replace(/\.$/, ''))
	.refine(
		(value) => /^(?!-)[a-z0-9-]{1,63}(?:\.(?!-)[a-z0-9-]{1,63})+$/.test(value),
		'Enter a hostname like app.example.com (no scheme, port or path).',
	);

// -------------------------------------------------------------------- volumes

const volumeMountStringSchema = z
	.string()
	.trim()
	.min(3)
	.max(320)
	.superRefine((value, ctx) => {
		const parts = value.split(':');
		if (parts.length < 2 || parts.length > 3) {
			ctx.addIssue({ code: 'custom', message: 'Use "<volume>:</absolute/path>" or "<volume>:</absolute/path>:ro".' });
			return;
		}
		const [volume, mountPath, mode] = parts;
		if (!volume || !blueprintResourceNameSchema.safeParse(volume).success)
			ctx.addIssue({ code: 'custom', message: 'The volume name before ":" is invalid.' });
		if (mode !== undefined && mode !== 'ro')
			ctx.addIssue({ code: 'custom', message: 'The optional mount mode is "ro".' });
		const problem = appVolumeMountPathProblem(mountPath ?? '');
		if (problem) ctx.addIssue({ code: 'custom', message: problem });
	})
	.transform((value) => {
		const [volume = '', mountPath = '', mode] = value.split(':');
		return { volume, mountPath, readOnly: mode === 'ro' };
	});

const volumeMountObjectSchema = z.strictObject({
	volume: blueprintResourceNameSchema,
	mountPath: appVolumeMountPathSchema,
	readOnly: z.boolean().default(false),
});

/** A service mount: `data:/var/lib/app` (compact) or `{ volume, mountPath, readOnly }`. */
export const blueprintVolumeMountSchema = z.union([volumeMountStringSchema, volumeMountObjectSchema]);
export type BlueprintVolumeMount = z.infer<typeof blueprintVolumeMountSchema>;

// -------------------------------------------------------------------- services

const serviceEnvSchema = z.record(blueprintEnvNameSchema, z.string().max(16_384)).default({});

const serviceCommonShape = {
	memoryMb: z.number().int().min(32).max(16_384).optional(),
	cpus: z.number().positive().max(16).optional(),
	volumes: z.array(blueprintVolumeMountSchema).max(20).default([]),
	env: serviceEnvSchema,
};

const staticServiceSchema = z.strictObject({
	type: z.literal('static'),
	/** Build output directory, relative to skiff.yaml. */
	path: blueprintRelativePathSchema,
	spa: z.boolean().default(false),
	cleanUrls: z.boolean().default(false),
	trailingSlash: z.enum(['always', 'never', 'ignore']).default('ignore'),
	notFound: staticFileSchema.optional(),
});

const processServiceSchema = z.strictObject({
	type: z.literal('process'),
	command: z.array(z.string().min(1).max(1024)).min(1).max(64),
	port: z.number().int().min(1).max(65_535).default(3000),
	healthPath: staticFileSchema.default('/'),
	...serviceCommonShape,
});

const containerServiceSchema = z.strictObject({
	type: z.literal('container'),
	image: z.string().min(1).max(512),
	/** Optional argv override; the image's entrypoint is used when omitted. */
	command: z.array(z.string().min(1).max(1024)).min(1).max(64).optional(),
	port: z.number().int().min(1).max(65_535).default(3000),
	healthPath: staticFileSchema.default('/'),
	...serviceCommonShape,
});

export const blueprintServiceSchema = z.discriminatedUnion('type', [
	staticServiceSchema,
	processServiceSchema,
	containerServiceSchema,
]);
export type BlueprintService = z.infer<typeof blueprintServiceSchema>;

// -------------------------------------------------------------------- data

export const blueprintDatabaseSchema = z
	.strictObject({
		engine: z.enum(databaseEngines).default('postgres'),
		version: z.string().min(1).max(16).optional(),
		memoryMb: z.number().int().min(128).max(16_384).optional(),
		cpus: z.number().positive().max(8).optional(),
		/** Storage budget in MB (applied as `storageMb` on the database). */
		sizeMb: z.number().int().min(256).max(1_048_576).default(10_240),
		extensions: z.array(databaseExtensionSchema).max(20).default([]),
		pooler: z.boolean().default(true),
	})
	.superRefine((input, ctx) => {
		const info = databaseEngineRegistry[input.engine];
		if (input.version && !info.versions.includes(input.version))
			ctx.addIssue({ code: 'custom', path: ['version'], message: `${info.label} versions: ${info.versions.join(', ')}.` });
		if (input.memoryMb !== undefined && input.memoryMb < info.minMemoryMb)
			ctx.addIssue({ code: 'custom', path: ['memoryMb'], message: `${info.label} needs at least ${info.minMemoryMb} MB.` });
	});

export const blueprintBucketSchema = z.strictObject({
	access: z.enum(bucketAccesses).default('private'),
	versioning: z.boolean().default(false),
	/** Per-bucket budget for alerts and quotas, in MB. */
	quotaMb: z.number().int().min(1).max(10_485_760).optional(),
});

export const blueprintStorageSchema = z.strictObject({
	public: z.boolean().default(false),
	memoryMb: z.number().int().min(128).max(16_384).optional(),
	cpus: z.number().positive().max(8).optional(),
	/** Storage instance budget, in MB. */
	sizeMb: z.number().int().min(256).max(10_485_760).default(10_240),
	buckets: z.record(bucketNameSchema, blueprintBucketSchema).default({}),
});

export const blueprintJobSchema = z.strictObject({
	schedule: cronSchema,
	command: z.array(z.string().min(1).max(1024)).min(1).max(64),
	timeoutSeconds: z.number().int().min(10).max(86_400).default(300),
	concurrency: z.enum(jobConcurrencyModes).default('forbid'),
	maxRetries: z.number().int().min(0).max(10).default(0),
	memoryMb: z.number().int().min(32).max(8192).optional(),
	cpus: z.number().positive().max(8).optional(),
	enabled: z.boolean().default(true),
	environment: blueprintEnvironmentNameSchema.default('production'),
});

export const blueprintVolumeSchema = z
	.strictObject({
		sizeMb: z.number().int().min(1).max(1_048_576).default(1024),
		backing: z.enum(appVolumeBackings).default('state_dir'),
		nodeVolume: z.string().min(3).max(40).optional(),
		singleWriter: z.boolean().default(true),
	})
	.superRefine((input, ctx) => {
		if (input.backing === 'node_volume' && !input.nodeVolume)
			ctx.addIssue({ code: 'custom', path: ['nodeVolume'], message: 'Choose the node volume that backs this volume.' });
		if (input.backing === 'state_dir' && input.nodeVolume)
			ctx.addIssue({ code: 'custom', path: ['nodeVolume'], message: 'A state-dir volume cannot name a node volume.' });
	});

export const blueprintAttachmentSchema = z
	.strictObject({
		/** Attach a managed database; mutually exclusive with `storage`. */
		database: blueprintResourceNameSchema.optional(),
		/** Attach a storage instance; mutually exclusive with `database`. */
		storage: blueprintResourceNameSchema.optional(),
		/** Env prefix applied to the attachment (`DATABASE_URL`, `S3_ENDPOINT_URL`, …). */
		prefix: blueprintEnvPrefixSchema.optional(),
		grants: z
			.array(
				z.strictObject({
					bucket: bucketNameSchema,
					mode: z.enum(storageGrantModes).default('read-write'),
				}),
			)
			.max(20)
			.default([]),
	})
	.superRefine((input, ctx) => {
		if (Boolean(input.database) === Boolean(input.storage))
			ctx.addIssue({ code: 'custom', message: 'Exactly one of `database` or `storage` is required.' });
		if (input.database && input.grants.length > 0)
			ctx.addIssue({ code: 'custom', path: ['grants'], message: 'Database attachments do not take bucket grants.' });
		if (input.storage && input.grants.length === 0)
			ctx.addIssue({ code: 'custom', path: ['grants'], message: 'Grant at least one bucket for a storage attachment.' });
	});
export type BlueprintAttachment = z.infer<typeof blueprintAttachmentSchema>;

// -------------------------------------------------------------------- document

const environmentConfigSchema = z.strictObject({
	/** Access mode for this environment's production pointer. */
	access: z.enum(accessModes).optional(),
});

const domainConfigSchema = z.strictObject({
	host: blueprintHostSchema,
	/** Service that answers this host; omitted uses the project's default service. */
	service: blueprintResourceNameSchema.optional(),
});

/**
 * The v1 document. Every object is strict, so `unknown field` errors name the exact path. Cross
 * references are checked here so `plan` fails before it touches any service.
 */
export const blueprintSchema = z
	.strictObject({
		apiVersion: blueprintApiVersionSchema,
		project: blueprintProjectSchema,
		environments: z.record(blueprintEnvironmentNameSchema, environmentConfigSchema).default({}),
		services: z.record(blueprintResourceNameSchema, blueprintServiceSchema).default({}),
		databases: z.record(blueprintResourceNameSchema, blueprintDatabaseSchema).default({}),
		storage: z.record(blueprintResourceNameSchema, blueprintStorageSchema).default({}),
		jobs: z.record(blueprintResourceNameSchema, blueprintJobSchema).default({}),
		volumes: z.record(blueprintResourceNameSchema, blueprintVolumeSchema).default({}),
		domains: z.array(domainConfigSchema).max(100).default([]),
		/** Plain, visible configuration per environment. Never secrets. */
		env: z.record(blueprintEnvironmentNameSchema, z.record(blueprintEnvNameSchema, z.string().max(16_384))).default({}),
		/** Secret **references** per environment; values resolve from the project secret store. */
		secrets: z.record(blueprintEnvironmentNameSchema, z.array(blueprintSecretNameSchema).max(200)).default({}),
		attachments: z.array(blueprintAttachmentSchema).max(100).default([]),
		previews: previewPolicySchema.optional(),
	})
	.superRefine((doc, ctx) => {
		const environmentNames = new Set(['production', ...Object.keys(doc.environments)]);

		for (const [serviceName, service] of Object.entries(doc.services)) {
			const mounts = new Set<string>();
			const serviceVolumes = service.type === 'static' ? [] : service.volumes;
			serviceVolumes.forEach((mount, index) => {
				if (!doc.volumes[mount.volume])
					ctx.addIssue({
						code: 'custom',
						path: ['services', serviceName, 'volumes', index, 'volume'],
						message: `Volume "${mount.volume}" is not declared.`,
					});
				if (mounts.has(mount.mountPath))
					ctx.addIssue({
						code: 'custom',
						path: ['services', serviceName, 'volumes', index, 'mountPath'],
						message: `Two volumes are mounted at ${mount.mountPath}.`,
					});
				mounts.add(mount.mountPath);
			});
		}

		doc.domains.forEach((domain, index) => {
			if (domain.service && !doc.services[domain.service])
				ctx.addIssue({
					code: 'custom',
					path: ['domains', index, 'service'],
					message: `Service "${domain.service}" is not declared.`,
				});
		});

		doc.attachments.forEach((attachment, index) => {
			if (attachment.database) {
				if (!doc.databases[attachment.database])
					ctx.addIssue({
						code: 'custom',
						path: ['attachments', index, 'database'],
						message: `Database "${attachment.database}" is not declared.`,
					});
				return;
			}
			if (!attachment.storage) return;
			const storage = doc.storage[attachment.storage];
			if (!storage) {
				ctx.addIssue({
					code: 'custom',
					path: ['attachments', index, 'storage'],
					message: `Storage "${attachment.storage}" is not declared.`,
				});
				return;
			}
			attachment.grants.forEach((grant, grantIndex) => {
				if (!storage.buckets[grant.bucket])
					ctx.addIssue({
						code: 'custom',
						path: ['attachments', index, 'grants', grantIndex, 'bucket'],
						message: `Bucket "${grant.bucket}" is not declared on storage "${attachment.storage}".`,
					});
			});
		});

		for (const [jobName, job] of Object.entries(doc.jobs)) {
			if (!environmentNames.has(job.environment))
				ctx.addIssue({
					code: 'custom',
					path: ['jobs', jobName, 'environment'],
					message: `Environment "${job.environment}" is not declared.`,
				});
		}

		for (const section of ['env', 'secrets'] as const) {
			for (const environment of Object.keys(doc[section])) {
				if (!environmentNames.has(environment))
					ctx.addIssue({
						code: 'custom',
						path: [section, environment],
						message: `Environment "${environment}" is not declared.`,
					});
			}
		}

		if (doc.previews?.enabled && doc.previews.data !== 'none' && Object.keys(doc.databases).length === 0)
			ctx.addIssue({
				code: 'custom',
				path: ['previews', 'data'],
				message: `Preview data mode "${doc.previews.data}" needs a database in the blueprint.`,
			});
	})
	.describe('Strict skiff.yaml v1 document.');
export type Blueprint = z.infer<typeof blueprintSchema>;

// -------------------------------------------------------------------- plan/apply

export const blueprintResourceKinds = [
	'project',
	'environment',
	'service',
	'database',
	'storage',
	'bucket',
	'job',
	'volume',
	'domain',
	'env',
	'secret',
	'attachment',
	'preview',
] as const;
export type BlueprintResourceKind = (typeof blueprintResourceKinds)[number];

export const blueprintPlanActions = ['create', 'update', 'delete', 'noop'] as const;
export type BlueprintPlanAction = (typeof blueprintPlanActions)[number];

/** One field-level change. Values are rendered strings; secret values never enter a diff. */
export const blueprintChangeSchema = z.strictObject({
	path: z.string().min(1).max(300),
	from: z.string().max(500).nullable(),
	to: z.string().max(500).nullable(),
});
export type BlueprintChange = z.infer<typeof blueprintChangeSchema>;

/** A stable-keyed resource in the plan graph (`services.web`, `databases.main`). */
export const blueprintResourceDiffSchema = z.strictObject({
	key: z.string().min(1).max(200),
	kind: z.enum(blueprintResourceKinds),
	action: z.enum(blueprintPlanActions),
	changes: z.array(blueprintChangeSchema).max(200).default([]),
	/** Human-readable reason for a delete or update (rename, drift, dependency). */
	reason: z.string().max(500).nullable(),
});
export type BlueprintResourceDiff = z.infer<typeof blueprintResourceDiffSchema>;

export const blueprintPlanSummarySchema = z.strictObject({
	create: z.number().int().nonnegative(),
	update: z.number().int().nonnegative(),
	delete: z.number().int().nonnegative(),
	noop: z.number().int().nonnegative(),
});
export type BlueprintPlanSummary = z.infer<typeof blueprintPlanSummarySchema>;

export const blueprintCostEstimateSchema = z.strictObject({
	monthlyUsd: z.number().nonnegative(),
	currency: z.literal('USD'),
});

/**
 * `skiff plan` output. `planHash` is stable for the same document + live state; apply requires it
 * so a plan cannot be applied against a different resource set.
 */
export const blueprintPlanViewSchema = z.strictObject({
	planHash: z.string().regex(/^[a-f0-9]{64}$/, 'Use a 64-character lowercase hex plan hash.'),
	project: z.string(),
	projectAction: z.enum(['create', 'update', 'noop', 'delete']),
	resources: z.array(blueprintResourceDiffSchema).max(1000),
	summary: blueprintPlanSummarySchema,
	warnings: z.array(z.string().max(1000)).max(200).default([]),
	/** Advisory estimate only; showback never bills (plan 16). */
	costEstimate: blueprintCostEstimateSchema.nullable().default(null),
	generatedAt: z.string(),
});
export type BlueprintPlanView = z.infer<typeof blueprintPlanViewSchema>;

export const blueprintAppliedResourceSchema = z.strictObject({
	key: z.string(),
	kind: z.enum(blueprintResourceKinds),
	/** Resource id once materialised; null when the step only updated a document. */
	id: z.string().nullable(),
});

/** `skiff apply` output; the operation id resumes progress and carries SSE events. */
export const blueprintApplyViewSchema = z.strictObject({
	operationId: z.string().min(1).max(100),
	planHash: z.string().regex(/^[a-f0-9]{64}$/),
	status: z.enum(operationStatuses),
	projectId: z.string().nullable(),
	resources: z.array(blueprintAppliedResourceSchema).max(1000).default([]),
	previewUrl: z.string().nullable().default(null),
	error: z.string().max(2000).nullable().default(null),
	appliedAt: z.string().nullable().default(null),
});
export type BlueprintApplyView = z.infer<typeof blueprintApplyViewSchema>;

/**
 * Compose import (plan 14) resolves a subset of `docker-compose.yml` into a blueprint. The
 * result carries the candidate document plus every warning, so nothing applies implicitly.
 */
export const blueprintComposeImportResultSchema = z.strictObject({
	services: z
		.array(
			z.strictObject({
				name: z.string(),
				kind: z.enum(['static', 'process', 'container']),
			}),
		)
		.max(100),
	warnings: z.array(z.strictObject({ path: z.string(), message: z.string().max(1000) })).max(500).default([]),
	unsupported: z
		.array(z.strictObject({ path: z.string(), reason: z.string().max(1000) }))
		.max(500)
		.default([]),
	document: blueprintSchema,
});
export type BlueprintComposeImportResult = z.infer<typeof blueprintComposeImportResultSchema>;
