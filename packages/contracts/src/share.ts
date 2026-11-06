import * as z from 'zod';
import { SLUG_PATTERN } from './slugs.ts';

/** Cluster shares (docs/CLUSTERING.md §5.2, C3). Platform-level network filesystem definitions. */

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
	.refine((path) => path.startsWith('/'), 'The export must be an absolute path.')
	.refine((path) => !path.split('/').includes('..'), 'The export must not contain "..".');

export const shareCreateSchema = z
	.object({
		name: shareNameSchema,
		protocol: z.enum(shareProtocols),
		server: shareServerSchema,
		exportPath: shareExportPathSchema,
		zone: z.string().trim().min(1).max(32).default('default'),
		readOnly: z.boolean().default(true),
		/** Opaque reference resolved at activation; never a password. */
		credentialsRef: z.string().trim().min(1).max(100).nullable().optional(),
	})
	.strict();
export type ShareCreate = z.input<typeof shareCreateSchema>;

export const shareUpdateSchema = z
	.object({
		server: shareServerSchema.optional(),
		exportPath: shareExportPathSchema.optional(),
		zone: z.string().trim().min(1).max(32).optional(),
		readOnly: z.boolean().optional(),
		credentialsRef: z.string().trim().min(1).max(100).nullable().optional(),
	})
	.strict()
	.refine((input) => Object.keys(input).length > 0, 'Nothing to update.');
export type ShareUpdate = z.infer<typeof shareUpdateSchema>;

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
	grants: ShareGrant[];
	createdAt: string;
	updatedAt: string;
}
