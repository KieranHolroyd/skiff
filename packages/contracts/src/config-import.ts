import * as z from 'zod';

/**
 * Config import (docs/OPERATIONS.md §14): recreate an organisation's configuration on another
 * Yoal instance from a config export (`yoal.export/v1`, §13).
 *
 * Import is create-only. Resources are matched by their natural name (project slug, database
 * name, role name, …): one that already exists is left exactly as it is and reported as
 * `exists`, so a second run only does what is still missing. Nothing is updated or deleted.
 *
 * The export never holds secret values or credentials. Secrets can be supplied in the request
 * (`secrets`); everything else that needs a credential, and everything the importer cannot
 * recreate (access keys, deployments, data), is listed under `manual`.
 */

export const configImportActions = ['create', 'exists', 'skip'] as const;
export type ConfigImportAction = (typeof configImportActions)[number];

export const configImportStatuses = ['planned', 'done', 'exists', 'skipped', 'failed'] as const;
export type ConfigImportStatus = (typeof configImportStatuses)[number];

/** Secret values supplied with the import: `NAME` is org-wide, `project/NAME` is one project's. */
export const configImportSecretsSchema = z.record(
	z.string().regex(/^([a-z0-9][a-z0-9-]*\/)?[A-Za-z_][A-Za-z0-9_]*$/, 'Use NAME or project-slug/NAME.'),
	z.string().max(64 * 1024),
);

export const configImportRequestSchema = z.strictObject({
	/** The export document: the parsed object, or its YAML/JSON text. */
	document: z.union([z.string().min(2).max(8 * 1024 * 1024), z.record(z.string(), z.unknown())]),
	/** Only these top-level sections (`projects`, `databases`, …). Default: every section. */
	only: z.array(z.string().min(1).max(40)).max(40).optional(),
	/** Leave these top-level sections out. */
	skip: z.array(z.string().min(1).max(40)).max(40).optional(),
	/** Only these projects (by slug). Org-level sections are still imported. */
	projects: z.array(z.string().min(1).max(64)).max(500).optional(),
	secrets: configImportSecretsSchema.optional(),
});
export type ConfigImportRequest = z.infer<typeof configImportRequestSchema>;

export interface ConfigImportStep {
	/** Stable key: `projects.web`, `projects.web.environments.staging`, `databases.db`, … */
	key: string;
	section: string;
	kind: string;
	name: string;
	action: ConfigImportAction;
	status: ConfigImportStatus;
	/** Why it is `exists`/`skip`, or what failed. */
	reason: string | null;
	/** Keys that must succeed first; a failed dependency skips this step. */
	dependsOn: string[];
}

/** Something the importer cannot recreate; the operator does it by hand. */
export interface ConfigImportManual {
	section: string;
	item: string;
	what: string;
}

export interface ConfigImportView {
	mode: 'plan' | 'apply';
	source: { platform: string | null; org: string | null; exportedAt: string | null };
	steps: ConfigImportStep[];
	manual: ConfigImportManual[];
	warnings: string[];
	summary: Record<ConfigImportStatus, number>;
}
