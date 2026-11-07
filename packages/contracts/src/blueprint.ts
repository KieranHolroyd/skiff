import * as z from 'zod';
import { brokerEngineRegistry, brokerEngines, brokerEnvPrefixSchema, brokerNameSchema } from './broker.ts';
import {
	databaseEngineRegistry,
	databaseEngines,
	databaseEnvPrefixSchema,
	databaseExtensionAllowlist,
	databaseExtensionSchema,
	databaseNameSchema,
	databaseVariants,
} from './database.ts';
import {
	STORAGE_RESERVED_ENVIRONMENTS,
	bucketAccesses,
	bucketNameSchema,
	storageEnvPrefixSchema,
	storageGrantModes,
	storageNameSchema,
} from './object-storage.ts';
import { itemStatuses, operationStatuses } from './operations.ts';
import { SLUG_PATTERN } from './slugs.ts';

/**
 * Blueprints, version 1 (plan 11, docs/OPERATIONS.md §12): one declarative file describes a
 * *stack* — projects with their environments, domains and workload settings, plus the managed
 * databases, object storage and queue brokers they use and the attachments between them.
 *
 * `plan` diffs the file against live state and never changes anything; `apply` runs that diff
 * through the normal service layer as one operation, so permissions, quotas and audit entries are
 * exactly what the same clicks in the dashboard would produce. A second apply of the same file is
 * a no-op.
 *
 * Map keys are the real resource names (`projects.shop-web` is the project with slug
 * `shop-web`, `databases.shop-db` the database named `shop-db`), so a blueprint never invents
 * names. Every object is strict: an unknown field is an error with its exact path.
 *
 * Blueprints never hold secret values. `secrets:` names references the workload resolves from the
 * secret store at activation; a reference that does not resolve fails the plan, not the apply.
 * Plain `env:` values are visible configuration and must not hold credentials.
 */

export const BLUEPRINT_API_VERSION = 'skiff/v1';
export const blueprintApiVersionSchema = z.literal(BLUEPRINT_API_VERSION);

/** File names the CLI looks for, in order, when no path is given. */
export const BLUEPRINT_FILE_NAMES = ['skiff.blueprint.yaml', 'skiff.blueprint.yml', 'skiff.blueprint.json'] as const;

/** Largest blueprint text a surface accepts. */
export const BLUEPRINT_MAX_BYTES = 512 * 1024;

/** Stack names the REST routes use as path segments. */
const RESERVED_STACK_NAMES = new Set(['plan', 'apply', 'validate', 'schema']);

const slugShape = (label: string) =>
	z
		.string()
		.min(3, `${label} names are 3–40 characters.`)
		.max(40, `${label} names are 3–40 characters.`)
		.regex(SLUG_PATTERN, 'Use lowercase letters, digits and single hyphens; start and end with a letter or digit.')
		.refine((value) => !value.includes('--'), 'Double hyphens are not allowed.');

/** The stack's identity in the org: what a later plan compares against and prunes from. */
export const blueprintStackNameSchema = slugShape('Stack').refine(
	(value) => !RESERVED_STACK_NAMES.has(value),
	'This stack name is reserved.',
);

/** A project slug (`projects.<slug>`). Slugs are unique across the platform. */
export const blueprintProjectSlugSchema = slugShape('Project');

/** Access a blueprint can set. Password access needs a password, which never goes in a file. */
export const blueprintAccessModes = ['public', 'platform'] as const;
const accessSchema = z.enum(blueprintAccessModes);

export const blueprintEnvironmentNameSchema = z
	.string()
	.trim()
	.min(1)
	.max(30)
	.regex(/^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/, 'Environment names are 1–30 lowercase letters, digits and hyphens.')
	.refine((value) => !value.includes('--'), 'Environment names cannot contain "--".')
	.refine((value) => value !== 'production', 'production is built in; set its access with `access.production`.')
	.refine((value) => !STORAGE_RESERVED_ENVIRONMENTS.has(value), 'This environment name is reserved for storage endpoints.');

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

const urlPathSchema = z
	.string()
	.trim()
	.min(1)
	.max(512)
	.refine((value) => value.startsWith('/'), 'Use a URL path starting with "/".');

const argvSchema = z.array(z.string().min(1).max(1024)).min(1).max(64);

// -------------------------------------------------------------------- projects

export const blueprintProjectRuntimes = ['static', 'process', 'container', 'function'] as const;

/**
 * One project. Workload fields (`command` … `secrets`) are only for process and container
 * projects; each one is managed only when it is present, so a field you leave out keeps whatever
 * the dashboard or CLI set.
 */
export const blueprintProjectSchema = z
	.strictObject({
		/** Display name; defaults to the slug on create. */
		name: z.string().trim().min(1).max(120).optional(),
		/** Fixed for the project's life. */
		runtime: z.enum(blueprintProjectRuntimes).default('static'),
		/** `edge`, `auto` or a node id. */
		placement: z.string().min(1).max(64).optional(),
		access: z
			.strictObject({
				production: accessSchema.optional(),
				previews: accessSchema.optional(),
			})
			.optional(),
		environments: z.record(blueprintEnvironmentNameSchema, z.strictObject({ access: accessSchema.optional() })).default({}),
		domains: z.array(blueprintHostSchema).max(50).default([]),
		/** Process: argv run in the release (no shell). Container: overrides the image's command. */
		command: argvSchema.optional(),
		/** Container: OCI image reference (pin a digest or a version tag). */
		image: z.string().min(1).max(512).optional(),
		port: z.number().int().min(1).max(65_535).optional(),
		healthPath: urlPathSchema.optional(),
		memoryMb: z.number().int().min(32).max(8192).optional(),
		cpus: z.number().positive().max(8).optional(),
		replicas: z.number().int().min(1).max(20).optional(),
		/** Plain, visible variables. The whole set is replaced when present. */
		env: z.record(blueprintEnvNameSchema, z.string().max(16_384)).optional(),
		/** Secret references the workload receives as env vars. The whole set is replaced when present. */
		secrets: z.array(blueprintSecretNameSchema).max(128).optional(),
	})
	.superRefine((project, ctx) => {
		const workload = (['command', 'image', 'port', 'healthPath', 'memoryMb', 'cpus', 'replicas', 'env', 'secrets'] as const).filter(
			(field) => project[field] !== undefined,
		);
		if ((project.runtime === 'static' || project.runtime === 'function') && workload.length > 0)
			for (const field of workload)
				ctx.addIssue({
					code: 'custom',
					path: [field],
					message:
						project.runtime === 'static'
							? 'Static projects have no workload settings.'
							: 'Function settings come from the function bundle, not the blueprint.',
				});
		if (project.image !== undefined && project.runtime !== 'container')
			ctx.addIssue({ code: 'custom', path: ['image'], message: 'Only container projects take an image.' });
		if (project.secrets && new Set(project.secrets).size !== project.secrets.length)
			ctx.addIssue({ code: 'custom', path: ['secrets'], message: 'Each secret is referenced once.' });
		if (project.env && project.secrets)
			for (const name of project.secrets)
				if (name in project.env)
					ctx.addIssue({ code: 'custom', path: ['env', name], message: `${name} is also a secret reference.` });
		if (new Set(project.domains).size !== project.domains.length)
			ctx.addIssue({ code: 'custom', path: ['domains'], message: 'Each domain is listed once.' });
	});
export type BlueprintProject = z.infer<typeof blueprintProjectSchema>;

// -------------------------------------------------------------------- data services

/** A managed database. Optional fields keep the platform default on create and stay unmanaged after. */
export const blueprintDatabaseSchema = z
	.strictObject({
		engine: z.enum(databaseEngines).default('postgres'),
		version: z.string().min(1).max(16).optional(),
		/** Fixed for life (D126). */
		variant: z.enum(databaseVariants).optional(),
		memoryMb: z.number().int().min(128).max(16_384).optional(),
		cpus: z.number().positive().max(8).optional(),
		storageMb: z.number().int().min(256).max(1_048_576).optional(),
		/** Added on apply; removing one from the file never drops it from the database. */
		extensions: z.array(databaseExtensionSchema).max(databaseExtensionAllowlist.length).optional(),
		pooler: z.boolean().optional(),
	})
	.superRefine((input, ctx) => {
		const info = databaseEngineRegistry[input.engine];
		if (input.version && !info.versions.includes(input.version))
			ctx.addIssue({ code: 'custom', path: ['version'], message: `${info.label} versions: ${info.versions.join(', ')}.` });
		if (input.memoryMb !== undefined && input.memoryMb < info.minMemoryMb)
			ctx.addIssue({ code: 'custom', path: ['memoryMb'], message: `${info.label} needs at least ${info.minMemoryMb} MB.` });
		if (input.extensions?.length && !info.capabilities.extensions)
			ctx.addIssue({ code: 'custom', path: ['extensions'], message: `${info.label} has no extensions.` });
		if (input.pooler && !info.capabilities.pooler)
			ctx.addIssue({ code: 'custom', path: ['pooler'], message: `${info.label} has no connection pooler.` });
	});
export type BlueprintDatabase = z.infer<typeof blueprintDatabaseSchema>;

export const blueprintBucketSchema = z.strictObject({
	access: z.enum(bucketAccesses).optional(),
	versioning: z.boolean().optional(),
	/** Per-bucket quota in MB; `null` removes one. */
	quotaMb: z.number().int().min(1).max(10_485_760).nullable().optional(),
});
export type BlueprintBucket = z.infer<typeof blueprintBucketSchema>;

export const blueprintStorageSchema = z.strictObject({
	/** Serve the S3 API at `<name>--s3.<contentDomain>`. */
	public: z.boolean().optional(),
	memoryMb: z.number().int().min(128).max(16_384).optional(),
	cpus: z.number().positive().max(8).optional(),
	storageMb: z.number().int().min(256).max(10_485_760).optional(),
	buckets: z.record(bucketNameSchema, blueprintBucketSchema).default({}),
});
export type BlueprintStorage = z.infer<typeof blueprintStorageSchema>;

export const blueprintBrokerSchema = z
	.strictObject({
		engine: z.enum(brokerEngines).default('nats'),
		/** A newer listed version upgrades in place; a downgrade fails the plan. */
		version: z.string().min(1).max(16).optional(),
		memoryMb: z.number().int().min(64).max(16_384).optional(),
		cpus: z.number().positive().max(8).optional(),
		storageMb: z.number().int().min(256).max(1_048_576).optional(),
	})
	.superRefine((input, ctx) => {
		const info = brokerEngineRegistry[input.engine];
		if (input.version && !info.versions.includes(input.version))
			ctx.addIssue({ code: 'custom', path: ['version'], message: `${info.label} versions: ${info.versions.join(', ')}.` });
		if (input.memoryMb !== undefined && input.memoryMb < info.minMemoryMb)
			ctx.addIssue({ code: 'custom', path: ['memoryMb'], message: `${info.label} needs at least ${info.minMemoryMb} MB.` });
	});
export type BlueprintBroker = z.infer<typeof blueprintBrokerSchema>;

/** Connect one project to one database, storage instance or broker; its env vars appear at activation. */
export const blueprintAttachmentSchema = z
	.strictObject({
		project: blueprintProjectSlugSchema,
		database: databaseNameSchema.optional(),
		storage: storageNameSchema.optional(),
		broker: brokerNameSchema.optional(),
		/** Env prefix (`DATABASE_URL`, `S3_ENDPOINT_URL`, `NATS_URL`); defaults to the engine's. */
		prefix: z.string().optional(),
		/** Storage only: which buckets the project's key may use. */
		grants: z
			.array(z.strictObject({ bucket: bucketNameSchema, mode: z.enum(storageGrantModes).default('read-write') }))
			.max(20)
			.optional(),
	})
	.superRefine((input, ctx) => {
		const targets = [input.database, input.storage, input.broker].filter(Boolean);
		if (targets.length !== 1)
			ctx.addIssue({ code: 'custom', message: 'Name exactly one of `database`, `storage` or `broker`.' });
		if (input.prefix !== undefined) {
			const schema = input.storage ? storageEnvPrefixSchema : input.broker ? brokerEnvPrefixSchema : databaseEnvPrefixSchema;
			const parsed = schema.safeParse(input.prefix);
			if (!parsed.success)
				ctx.addIssue({ code: 'custom', path: ['prefix'], message: parsed.error.issues[0]?.message ?? 'Invalid prefix.' });
		}
		if (input.grants !== undefined && !input.storage)
			ctx.addIssue({ code: 'custom', path: ['grants'], message: 'Only storage attachments take bucket grants.' });
		if (input.storage && !input.grants?.length)
			ctx.addIssue({ code: 'custom', path: ['grants'], message: 'Grant at least one bucket for a storage attachment.' });
		if (input.grants && new Set(input.grants.map((grant) => grant.bucket)).size !== input.grants.length)
			ctx.addIssue({ code: 'custom', path: ['grants'], message: 'Each bucket may be granted once.' });
	});
export type BlueprintAttachment = z.infer<typeof blueprintAttachmentSchema>;

/** Which managed service an attachment names. */
export function attachmentTarget(attachment: BlueprintAttachment): { type: 'database' | 'storage' | 'broker'; name: string } {
	if (attachment.database) return { type: 'database', name: attachment.database };
	if (attachment.storage) return { type: 'storage', name: attachment.storage };
	return { type: 'broker', name: attachment.broker ?? '' };
}

// -------------------------------------------------------------------- document

/**
 * The v1 document. Cross references are checked here, so a plan fails on a typo before it reads
 * any live state.
 */
export const blueprintSchema = z
	.strictObject({
		apiVersion: blueprintApiVersionSchema,
		name: blueprintStackNameSchema,
		projects: z.record(blueprintProjectSlugSchema, blueprintProjectSchema).default({}),
		databases: z.record(databaseNameSchema, blueprintDatabaseSchema).default({}),
		storage: z.record(storageNameSchema, blueprintStorageSchema).default({}),
		brokers: z.record(brokerNameSchema, blueprintBrokerSchema).default({}),
		attachments: z.array(blueprintAttachmentSchema).max(200).default([]),
	})
	.superRefine((doc, ctx) => {
		for (const [name, database] of Object.entries(doc.databases))
			if (database.engine === 'postgres' && name.startsWith('pg-'))
				ctx.addIssue({
					code: 'custom',
					path: ['databases', name],
					message: 'Postgres database names cannot start with "pg-".',
				});

		const pairs = new Set<string>();
		const prefixes = new Set<string>();
		doc.attachments.forEach((attachment, index) => {
			const target = attachmentTarget(attachment);
			if (!target.name) return;
			const project = doc.projects[attachment.project];
			if (!project)
				ctx.addIssue({
					code: 'custom',
					path: ['attachments', index, 'project'],
					message: `Project "${attachment.project}" is not declared under projects.`,
				});
			else if (project.runtime === 'static')
				ctx.addIssue({
					code: 'custom',
					path: ['attachments', index, 'project'],
					message: `Project "${attachment.project}" is static; only app projects use data services.`,
				});
			const declared =
				target.type === 'database' ? doc.databases : target.type === 'storage' ? doc.storage : doc.brokers;
			if (!declared[target.name])
				ctx.addIssue({
					code: 'custom',
					path: ['attachments', index, target.type],
					message: `${target.type === 'storage' ? 'Storage' : target.type === 'database' ? 'Database' : 'Broker'} "${target.name}" is not declared.`,
				});
			const pair = `${attachment.project}/${target.type}/${target.name}`;
			if (pairs.has(pair))
				ctx.addIssue({ code: 'custom', path: ['attachments', index], message: 'This attachment is listed twice.' });
			pairs.add(pair);
			const prefix = `${attachment.project}/${target.type}/${attachment.prefix ?? defaultAttachmentPrefix(doc, target)}`;
			if (prefixes.has(prefix))
				ctx.addIssue({
					code: 'custom',
					path: ['attachments', index, 'prefix'],
					message: `"${attachment.project}" already uses this env prefix; set a different \`prefix\`.`,
				});
			prefixes.add(prefix);
			if (target.type === 'storage') {
				const storage = doc.storage[target.name];
				attachment.grants?.forEach((grant, grantIndex) => {
					if (storage && !storage.buckets[grant.bucket])
						ctx.addIssue({
							code: 'custom',
							path: ['attachments', index, 'grants', grantIndex, 'bucket'],
							message: `Bucket "${grant.bucket}" is not declared on storage "${target.name}".`,
						});
				});
			}
		});
	})
	.describe('Skiff blueprint v1 (skiff.blueprint.yaml).');
export type Blueprint = z.infer<typeof blueprintSchema>;
export type BlueprintInput = z.input<typeof blueprintSchema>;

/** The env prefix an attachment gets when the file sets none. */
export function defaultAttachmentPrefix(
	doc: Pick<Blueprint, 'databases' | 'brokers'>,
	target: { type: 'database' | 'storage' | 'broker'; name: string },
): string {
	if (target.type === 'storage') return 'S3';
	if (target.type === 'broker') {
		const engine = doc.brokers[target.name]?.engine ?? 'nats';
		return brokerEngineRegistry[engine].defaultEnvPrefix;
	}
	const engine = doc.databases[target.name]?.engine ?? 'postgres';
	return databaseEngineRegistry[engine].defaultEnvPrefix;
}

// -------------------------------------------------------------------- plan/apply

export const blueprintResourceKinds = [
	'project',
	'environment',
	'service',
	'domain',
	'database',
	'storage',
	'bucket',
	'broker',
	'attachment',
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

/** A stable-keyed resource in the plan (`projects.shop-web`, `databases.shop-db`). */
export const blueprintResourceDiffSchema = z.strictObject({
	key: z.string().min(1).max(400),
	kind: z.enum(blueprintResourceKinds),
	action: z.enum(blueprintPlanActions),
	changes: z.array(blueprintChangeSchema).max(200).default([]),
	/** Why it is updated, deleted or adopted. */
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

export const blueprintPlanHashSchema = z.string().regex(/^[a-f0-9]{64}$/, 'Use the 64-character plan hash from plan.');

/**
 * `plan` output. `planHash` is stable for the same document and live state; apply takes it, and
 * refuses when live state moved since, so what runs is always what was reviewed.
 */
export const blueprintPlanViewSchema = z.strictObject({
	planHash: blueprintPlanHashSchema,
	stack: z.string(),
	/** `create` for a stack this org has never applied. */
	stackAction: z.enum(['create', 'update', 'noop']),
	/** The planned operation apply runs; it expires with the plan. */
	operationId: z.string(),
	prune: z.boolean(),
	resources: z.array(blueprintResourceDiffSchema).max(1000),
	summary: blueprintPlanSummarySchema,
	warnings: z.array(z.string().max(1000)).max(200).default([]),
	generatedAt: z.string(),
	expiresAt: z.string().nullable(),
});
export type BlueprintPlanView = z.infer<typeof blueprintPlanViewSchema>;

export const blueprintAppliedResourceSchema = z.strictObject({
	key: z.string(),
	kind: z.enum(blueprintResourceKinds),
	action: z.enum(blueprintPlanActions),
	status: z.enum(itemStatuses),
	/** Why a step was skipped (`up to date`, `an earlier step failed`). */
	reason: z.string().nullable(),
	error: z.string().nullable(),
});
export type BlueprintAppliedResource = z.infer<typeof blueprintAppliedResourceSchema>;

/** `apply` output; follow `operationId` for progress (`/operations/:id/stream`). */
export const blueprintApplyViewSchema = z.strictObject({
	operationId: z.string().min(1).max(100),
	planHash: blueprintPlanHashSchema,
	stack: z.string(),
	status: z.enum(operationStatuses),
	done: z.number().int().nonnegative(),
	total: z.number().int().nonnegative(),
	resources: z.array(blueprintAppliedResourceSchema).max(1000).default([]),
	error: z.string().max(2000).nullable().default(null),
	appliedAt: z.string().nullable().default(null),
});
export type BlueprintApplyView = z.infer<typeof blueprintApplyViewSchema>;

/** A stack this org has applied: what it manages and how its last apply went. */
export interface BlueprintStackView {
	name: string;
	/** Resource keys the stack created or adopted; only these can be pruned. */
	managed: string[];
	lastOperationId: string | null;
	lastStatus: string | null;
	/** The last document that applied cleanly, normalised; null until one did. */
	document: Blueprint | null;
	appliedPlanHash: string | null;
	appliedAt: string | null;
	appliedBy: string | null;
	createdAt: string;
	updatedAt: string;
}

/** `POST /blueprints/plan`: the file's text (YAML or JSON) or an already-parsed document. */
export const blueprintPlanRequestSchema = z.strictObject({
	document: z.union([z.string().min(1).max(BLUEPRINT_MAX_BYTES), z.record(z.string(), z.unknown())]),
	/** Delete managed resources the file no longer lists. */
	prune: z.boolean().default(false),
});
export type BlueprintPlanRequest = z.input<typeof blueprintPlanRequestSchema>;

/** `POST /blueprints/validate`: parse and check a document without reading live state. */
export const blueprintValidateRequestSchema = blueprintPlanRequestSchema.pick({ document: true });
export type BlueprintValidateRequest = z.input<typeof blueprintValidateRequestSchema>;

/** `POST /blueprints/apply`. A pruning plan also needs the stack name typed back. */
export const blueprintApplyRequestSchema = z.strictObject({
	planHash: blueprintPlanHashSchema,
	confirm: z.string().max(40).optional(),
});
export type BlueprintApplyRequest = z.input<typeof blueprintApplyRequestSchema>;

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
