import * as z from 'zod';
import { accessModes } from './model.ts';

/**
 * Named environments (D13 deferred them from v1). `production` always exists per project and keeps
 * the `<slug>.<contentDomain>` host. Additional environments get `<slug>--<env>.<contentDomain>`,
 * a single label so the wildcard certificate still covers them (D14).
 */

export const environmentSlugSchema = z
	.string()
	.min(1)
	.max(30)
	.transform((value) => value.trim().toLowerCase())
	.refine(
		(value) => /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])$/.test(value),
		'Environment names are 1–30 lowercase letters, digits and hyphens',
	)
	// `--` is reserved for preview hosts (`<slug>--<shortid>`), so an environment can never shadow one.
	.refine((value) => !value.includes('--'), 'Environment names cannot contain `--`')
	.refine((value) => value !== 'production', 'The production environment is built in');

export const environmentCreateSchema = z.object({
	name: z.string().min(1).max(60),
	slug: environmentSlugSchema.optional(),
	/** Access for this environment's production pointer; defaults to the project's preview mode. */
	access: z.enum(accessModes).optional(),
});
export type EnvironmentCreateInput = z.infer<typeof environmentCreateSchema>;

export const environmentUpdateSchema = z.object({
	name: z.string().min(1).max(60).optional(),
	access: z.enum(accessModes).optional(),
});
export type EnvironmentUpdateInput = z.infer<typeof environmentUpdateSchema>;

export interface EnvironmentView {
	id: string;
	projectId: string;
	projectSlug: string;
	name: string;
	slug: string;
	isProduction: boolean;
	access: (typeof accessModes)[number];
	host: string;
	/** Deployment currently served at this environment's host. */
	deploymentId: string | null;
	createdAt: string;
}
