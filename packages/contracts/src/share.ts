import * as z from 'zod';
import { SLUG_PATTERN } from './slugs.ts';
import { volumeNameSchema } from './volume.ts';
import type { DiskProfileView } from './disk.ts';

/**
 * Cluster shares (docs/CLUSTERING.md §5.2, C3). Platform-level network filesystem definitions.
 *
 * A share is defined once and mounted on the nodes that need it (`share_mounts`). A read-write
 * mount becomes a `bulk`, network disk on that node, so managed databases, storage instances and
 * app volumes can be stored on it (docs/STORAGE.md §3, D143).
 */

export const shareProtocols = ['nfs', 'smb'] as const;
export type ShareProtocol = (typeof shareProtocols)[number];
export const shareModes = ['ro', 'rw'] as const;
export type ShareMode = (typeof shareModes)[number];

export const shareNameSchema = z
	.string()
	.trim()
	.min(3)
	.max(40)
	.regex(SLUG_PATTERN, 'Use lowercase letters, digits and single hyphens.')
	.refine((name) => !name.includes('--'), 'Double hyphens are not allowed.');

export const shareServerSchema = z
	.string()
	.trim()
	.min(1)
	.max(253)
	.regex(/^[A-Za-z0-9._:[\]-]+$/, 'Use a hostname, IP address or host:port, without a scheme or path.');

export const shareExportPathSchema = z
	.string()
	.trim()
	.min(1)
	.max(512)
	.refine((path) => path.startsWith('/'), 'The export must be an absolute path (NFS /export, SMB /share).')
	.refine((path) => !path.split('/').includes('..'), 'The export must not contain "..".')
	.refine(
		(path) => /^\/[A-Za-z0-9._@+/-]*$/.test(path),
		'Use letters, digits and . _ @ + - / only; rename the export or share if it has spaces or $.',
	)
	.transform((path) => (path.length > 1 ? path.replace(/\/+$/, '') : path));

/**
 * SMB credentials. Write-only: sealed with the platform key, never returned, never in desired
 * state, logs or audit arguments. The node fetches them for one mount call only.
 */
export const shareCredentialsSchema = z
	.object({
		username: z
			.string()
			.trim()
			.min(1)
			.max(256)
			.regex(/^[^\n\r\0,]+$/, 'The username cannot contain commas or line breaks.'),
		password: z
			.string()
			.min(1)
			.max(256)
			.regex(/^[^\n\r\0]+$/, 'The password cannot contain line breaks.'),
		domain: z
			.string()
			.trim()
			.max(256)
			.regex(/^[^\n\r\0,]*$/, 'The domain cannot contain commas or line breaks.')
			.optional()
			.transform((value) => (value ? value : undefined)),
	})
	.strict();
export type ShareCredentials = z.input<typeof shareCredentialsSchema>;

export const shareCreateSchema = z
	.object({
		name: shareNameSchema,
		protocol: z.enum(shareProtocols),
		server: shareServerSchema,
		exportPath: shareExportPathSchema,
		zone: z.string().trim().min(1).max(32).default('default'),
		readOnly: z.boolean().default(true),
		/** Opaque reference resolved at activation; never a password. Superseded by `credentials`. */
		credentialsRef: z.string().trim().min(1).max(100).nullable().optional(),
		/** SMB username/password (sealed); NFS shares take none. */
		credentials: shareCredentialsSchema.optional(),
	})
	.strict()
	.superRefine((input, ctx) => {
		if (input.protocol === 'nfs' && input.credentials)
			ctx.addIssue({ code: 'custom', path: ['credentials'], message: 'NFS shares do not take a username or password.' });
		if (input.protocol === 'smb' && input.exportPath === '/')
			ctx.addIssue({ code: 'custom', path: ['exportPath'], message: 'Name the SMB share, e.g. /media.' });
	});
export type ShareCreate = z.input<typeof shareCreateSchema>;

export const shareUpdateSchema = z
	.object({
		server: shareServerSchema.optional(),
		exportPath: shareExportPathSchema.optional(),
		zone: z.string().trim().min(1).max(32).optional(),
		readOnly: z.boolean().optional(),
		credentialsRef: z.string().trim().min(1).max(100).nullable().optional(),
		/** Replace (object) or clear (null) the sealed SMB credentials. */
		credentials: shareCredentialsSchema.nullable().optional(),
	})
	.strict()
	.refine((input) => Object.keys(input).length > 0, 'Nothing to update.');
export type ShareUpdate = z.input<typeof shareUpdateSchema>;

export const shareGrantSchema = z.object({
	orgId: z.string().min(1).max(100),
	mode: z.enum(shareModes).default('ro'),
	pathPrefix: z.string().trim().max(256).default(''),
});
export type ShareGrant = z.infer<typeof shareGrantSchema>;

export const shareGrantsSchema = z.object({
	grants: z.array(shareGrantSchema).max(100),
});
export type ShareGrants = z.infer<typeof shareGrantsSchema>;

export interface ShareView {
	id: string;
	name: string;
	protocol: ShareProtocol;
	server: string;
	exportPath: string;
	zone: string;
	readOnly: boolean;
	credentialsRef: string | null;
	/** SMB credentials are stored (sealed). The values are never returned. */
	hasCredentials: boolean;
	/** The stored SMB username, for display; null for NFS or when none is stored. */
	username: string | null;
	grants: ShareGrant[];
	/** Where the share is mounted, and the disk each mount became. */
	mounts: ShareMountView[];
	createdAt: string;
	updatedAt: string;
}

// ------------------------------------------------------------------ mounts

export const shareMountStatuses = ['pending', 'mounted', 'failed', 'unmounting'] as const;
export type ShareMountStatus = (typeof shareMountStatuses)[number];

/** Node directory every share mounts under; the disk inventory reports it (docs/STORAGE.md §3). */
export const SHARE_MOUNT_ROOT = '/mnt/yoal-shares';

export function shareMountPath(shareName: string): string {
	return `${SHARE_MOUNT_ROOT}/${shareName}`;
}

/**
 * The disk source key the helper's inventory derives for this share once mounted:
 * `nfs:<server>:<export>` or `cifs:<server>/<share>`. Turning a mount into a disk matches on it.
 */
export function shareSourceKey(share: { protocol: ShareProtocol; server: string; exportPath: string }): string {
	const path = share.exportPath.length > 1 ? share.exportPath.replace(/\/+$/, '') : share.exportPath;
	return share.protocol === 'nfs' ? `nfs:${share.server}:${path}` : `cifs:${share.server}/${path.replace(/^\/+/, '')}`;
}

export const shareMountCreateSchema = z
	.object({
		/** Node id or name. */
		node: z.string().trim().min(1).max(100),
		/** The disk the mount becomes once mounted (D169). Defaults to the share name. */
		diskName: volumeNameSchema.optional(),
	})
	.strict();
export type ShareMountCreate = z.input<typeof shareMountCreateSchema>;

/** Use an existing mount as a disk (after it was stopped, or a name clash). */
export const shareMountLinkSchema = z.object({ diskName: volumeNameSchema }).strict();
export type ShareMountLink = z.input<typeof shareMountLinkSchema>;

export interface ShareMountView {
	id: string;
	nodeId: string;
	nodeName: string | null;
	mountPath: string;
	status: ShareMountStatus;
	message: string | null;
	/** The disk name the mount becomes (or became). */
	diskName: string | null;
	/** The disk, once the node reports the mount. */
	disk: { id: string; name: string; status: string; profile: DiskProfileView | null } | null;
	mountedAt: string | null;
	createdAt: string;
	updatedAt: string;
}

/** One share mount in a node's desired state. Never carries a credential. */
export const shareMountDesiredSchema = z.object({
	/** `share_mounts.id`; reports and the credential fetch use it. */
	id: z.string().min(1).max(100),
	/** Share name: the helper's mount id and the last segment of the mount path. */
	name: shareNameSchema,
	protocol: z.enum(shareProtocols),
	server: shareServerSchema,
	exportPath: z.string().min(1).max(512),
	readOnly: z.boolean(),
	/** Fetch SMB credentials from `/api/agent/share-mounts/<id>/credentials` before mounting. */
	credentials: z.boolean(),
	/** Bumped when the share's definition or credentials change, so the node remounts. */
	generation: z.string().min(1).max(100),
});
export type ShareMountDesired = z.infer<typeof shareMountDesiredSchema>;

/** A share the node must unmount (its mount row is `unmounting`). */
export const shareUnmountDesiredSchema = z.object({
	id: z.string().min(1).max(100),
	name: shareNameSchema,
});
export type ShareUnmountDesired = z.infer<typeof shareUnmountDesiredSchema>;

/** Heartbeat report: the node's view of each desired share mount. */
export const shareMountReportSchema = z.object({
	id: z.string().min(1).max(100),
	mounted: z.boolean(),
	error: z.string().max(2_000).nullable().default(null),
});
export type ShareMountReport = z.infer<typeof shareMountReportSchema>;

/** `GET /api/agent/share-mounts/<id>/credentials`. */
export const shareMountCredentialsSchema = z.object({
	id: z.string(),
	username: z.string(),
	password: z.string(),
	domain: z.string().nullable().default(null),
});
export type ShareMountCredentials = z.infer<typeof shareMountCredentialsSchema>;
