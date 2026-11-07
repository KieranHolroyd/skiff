import * as z from 'zod';
import { accessModes, runtimes } from './model.ts';
import { nodeStoragePathSchema } from './storage.ts';
import { nodeLabelsSchema, nodeRoleSchema, nodeZoneSchema, placementSpecSchema } from './cluster.ts';

const slug = z.string().min(3).max(40);
export const projectCreateSchema = z.object({
	name: z.string().min(1).max(120).optional(),
	slug: slug.optional(),
	runtime: z.enum(runtimes).default('static'),
	placement: z.string().min(1).max(64).default('edge'),
	/** Constraint spec; null keeps the shorthand above (CLUSTERING §3.4). */
	placementSpec: placementSpecSchema.optional(),
	productionAccess: z.enum(accessModes).default('public'),
	previewAccess: z.enum(accessModes).default('platform'),
	/** Required when either scope is `password`; each such scope stores its own copy. */
	password: z.string().min(8).max(200).optional(),
});
export type ProjectCreate = z.infer<typeof projectCreateSchema>;

export const projectUpdateSchema = z.object({
	name: z.string().min(1).max(120).optional(),
	placement: z.string().min(1).max(64).optional(),
	placementSpec: placementSpecSchema.nullable().optional(),
	productionAccess: z.enum(accessModes).optional(),
	previewAccess: z.enum(accessModes).optional(),
	pinned: z.boolean().optional(),
});
export type ProjectUpdate = z.infer<typeof projectUpdateSchema>;

/** One file in an inline deploy. `content` is text or base64 (`encoding: 'base64'`). */
export const inlineFileSchema = z.object({
	path: z.string().min(1).max(1024),
	content: z.string(),
	encoding: z.enum(['utf8', 'base64']).default('utf8'),
});
export type InlineFile = z.infer<typeof inlineFileSchema>;

/**
 * Environment slug on a deploy. `production` is built in and is the default; every other value
 * names an environment created through `/projects/:slug/environments`. Preview hosts keep their
 * `<slug>--<shortid>` shape regardless (D13, D14).
 */
const deployEnvironment = z
	.string()
	.min(1)
	.max(30)
	.regex(/^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/, 'Environment names are 1–30 lowercase letters, digits and hyphens')
	.refine((value) => !value.includes('--'), 'Environment names cannot contain `--`')
	.optional()
	.describe('Environment slug; defaults to production');

export const deployFilesSchema = z.object({
	project: slug,
	files: z.array(inlineFileSchema).min(1).max(20000),
	promote: z.boolean().default(true),
	message: z.string().max(500).optional(),
	/** Named environment to deploy into; production keeps the project's production pointer. */
	environment: deployEnvironment,
});
export type DeployFiles = z.infer<typeof deployFilesSchema>;

export const deploySiteSchema = z.object({
	name: slug,
	files: z.array(inlineFileSchema).min(1).max(20000).optional(),
	uploadId: z.string().min(1).max(64).optional(),
	promote: z.boolean().default(true),
	/** Named environment to deploy into; production keeps the project's production pointer. */
	environment: deployEnvironment,
	spa: z
		.boolean()
		.optional()
		.describe(
			'Does not enable SPA routing; that comes from `skiff.json` `{ "spa": true }` in the deployed files. Pass false to suppress the SPA suggestion in the response.',
		),
});
export type DeploySite = z.infer<typeof deploySiteSchema>;

export const createUploadSchema = z.object({
	project: slug,
	fileCount: z.number().int().positive().max(20000).optional(),
	totalBytes: z.number().int().positive().optional(),
});
export type CreateUpload = z.infer<typeof createUploadSchema>;

export const finalizeUploadSchema = z.object({
	uploadId: z.string().min(1).max(64),
	project: slug,
	promote: z.boolean().default(true),
	message: z.string().max(500).optional(),
});
export type FinalizeUpload = z.infer<typeof finalizeUploadSchema>;

export const setAccessSchema = z.object({
	scope: z.enum(['production', 'previews']).default('production'),
	mode: z.enum(accessModes),
	/**
	 * This scope's password. Required to switch a scope to `password`; may be omitted when the scope
	 * already has one, which keeps it. Each scope has its own password.
	 */
	password: z.string().min(8).max(200).optional(),
});
export type SetAccess = z.infer<typeof setAccessSchema>;

export const shareLinkCreateSchema = z.object({
	project: slug,
	deploymentId: z.string().max(64).optional(),
	expiresAt: z.string().datetime().optional(),
	maxVisitors: z.number().int().positive().optional(),
	maxRedemptions: z.number().int().positive().optional(),
	sessionTtlSeconds: z.number().int().positive().max(60 * 60 * 24 * 30).optional(),
	allowedEmails: z.array(z.string().email()).max(100).optional(),
	note: z.string().max(500).optional(),
});
export type ShareLinkCreate = z.infer<typeof shareLinkCreateSchema>;

export const promoteSchema = z.object({
	project: slug,
	deploymentId: z.string().min(1).max(64),
});
export type Promote = z.infer<typeof promoteSchema>;

export const paginationSchema = z.object({
	limit: z.coerce.number().int().min(1).max(200).default(50),
	cursor: z.string().max(256).optional(),
});
export type Pagination = z.infer<typeof paginationSchema>;

/**
 * Operator-editable node settings (platform admin). Identity (`id`, `mode`, token) is not editable
 * here: the edge is the first node to join and a token only changes through rotation. The slice
 * bounds match what `skiff-helper` accepts, so a saved value can always be applied.
 */
export const nodeUpdateSchema = z
	.object({
		name: z.string().trim().min(1).max(120).optional(),
		/** `host:port` the edge proxies to over WireGuard; `null` clears it. */
		publicAddress: z
			.string()
			.trim()
			.max(253)
			.regex(/^[A-Za-z0-9.\-[\]:]+$/, 'Use host or host:port, without a scheme or path.')
			.nullable()
			.optional(),
		/** `skiff-workloads.slice` memory budget (MemoryMax), in MB. */
		sliceMemoryMb: z.number().int().min(32).max(65_536).optional(),
		/** `skiff-workloads.slice` CPUWeight, relative to sibling slices (systemd default 100). */
		sliceCpuWeight: z.number().int().min(1).max(10_000).optional(),
		/** Lets the node's Builder claim git builds. */
		canBuild: z.boolean().optional(),
		/** Agent state and release cache directory; `null` restores the install default (D48). */
		dataDir: nodeStoragePathSchema.nullable().optional(),
		/** Builder scratch directory; `null` restores the install default (D48). */
		buildDir: nodeStoragePathSchema.nullable().optional(),
		/** Volume new managed instances on this node use when they name none (D74). */
		defaultVolumeId: z.string().max(100).nullable().optional(),
		/** Failure domain (CLUSTERING §3.2). */
		zone: nodeZoneSchema.optional(),
		/** What this node may run; removing a role in use is refused. */
		roles: z.array(nodeRoleSchema).min(1).max(5).optional(),
		/** Operator placement labels; `skiff.io/*` is reserved. */
		labels: nodeLabelsSchema.optional(),
		/** LAN address for direct peering inside one zone (C1). */
		lanEndpoint: z.string().trim().max(253).nullable().optional(),
		/** CPU reservation budget in millis; null removes it. */
		cpuBudgetMillis: z.number().int().min(100).max(1_000_000).nullable().optional(),
	})
	.strict();
export type NodeUpdate = z.infer<typeof nodeUpdateSchema>;
