import * as z from 'zod';

/** Request bodies for `/api/v1/sso/*` (IAM.md §12, I19). */
export const claimsSchema = z
	.object({
		email: z.string().trim().min(1).max(100).optional(),
		name: z.string().trim().min(1).max(100).optional(),
		groups: z.string().trim().min(1).max(100).optional()
	})
	.optional();

export const providerCreateSchema = z.object({
	name: z.string().trim().min(1).max(80),
	issuer: z.string().trim().min(1).max(500),
	clientId: z.string().trim().min(1).max(500),
	clientSecret: z.string().min(1).max(4000),
	discoveryUrl: z.string().trim().max(500).nullable().optional(),
	scopes: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
	claims: claimsSchema,
	enabled: z.boolean().optional()
});

export const providerUpdateSchema = providerCreateSchema.partial();

export const domainCreateSchema = z.object({
	domain: z.string().trim().min(1).max(253)
});

export const authMethodSchema = z.enum(['password', 'passkey', 'github', 'magic-link', 'sso']);

/** IAM.md I21: every field optional for a partial update. */
export const authPolicyUpdateSchema = z.object({
	requireSso: z.boolean().optional(),
	require2fa: z.boolean().optional(),
	allowedMethods: z.array(authMethodSchema).min(1).max(5).optional(),
	sessionMaxAge: z.number().int().positive().nullable().optional(),
	idleTimeout: z.number().int().positive().nullable().optional(),
	ipAllowlist: z.array(z.string().trim().min(1).max(64)).max(64).optional(),
	breakGlassUserIds: z.array(z.string().trim().min(1).max(128)).max(32).optional()
});
