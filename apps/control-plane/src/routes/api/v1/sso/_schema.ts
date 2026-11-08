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
