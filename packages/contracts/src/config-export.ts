/**
 * Config export (docs/OPERATIONS.md §13): a read-only snapshot of an organisation's configuration —
 * every project's settings, environments, domains, workload spec, jobs and attachments, plus the
 * org-level resources (managed services, IAM, identities, drains, events, pipelines, email…).
 *
 * It is configuration, not data: no deployments, artifacts, database rows, objects, logs, pool
 * users or history. It never holds secret values: secrets appear by name, and every section is the
 * same view the REST API returns, which is already write-only for credentials.
 *
 * Each section is read through the normal service layer with the caller's own permissions. A
 * section the caller cannot read, or whose feature is off, is left out and listed in `skipped`, so
 * an export never fails for one missing permission.
 */

export const CONFIG_EXPORT_VERSION = 'yoal.export/v1';

/** Top-level sections, in the order they appear in the document. */
export const configExportSections = [
	'projects',
	'secrets',
	'databases',
	'storage',
	'brokers',
	'iam',
	'serviceAccounts',
	'accessKeys',
	'federationTrusts',
	'accessPolicies',
	'userPools',
	'logDrains',
	'backupTargets',
	'eventRules',
	'alertRules',
	'email',
	'pipelines',
	'registryCredentials',
	'forgeConnections',
	'shares',
	'templates',
] as const;
export type ConfigExportSection = (typeof configExportSections)[number];

/** A section (or one project's sub-section) the export left out, and why. */
export interface ConfigExportSkip {
	/** `iam`, `projects.shop-web.volumes`, … */
	section: string;
	code: string;
	reason: string;
}

export interface ConfigExportHeader {
	apiVersion: typeof CONFIG_EXPORT_VERSION;
	exportedAt: string;
	platform: { url: string; contentDomain: string; version: string };
	org: { id: string; name: string | null; slug: string | null };
	/** Set when the export was limited to some projects (`?project=`). */
	projectFilter: string[] | null;
}
