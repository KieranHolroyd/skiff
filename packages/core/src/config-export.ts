import {
	CONFIG_EXPORT_VERSION,
	type ConfigExportHeader,
	type ConfigExportSkip,
	type Principal,
} from '@skiff/contracts';
import { CoreError } from './errors.ts';
import type { Core } from './index.ts';

/**
 * Config export (docs/OPERATIONS.md §13): one read-only snapshot of the caller's organisation's
 * configuration. Every section is the view the matching REST GET returns, read through the same
 * service call, so permissions, feature flags and secret masking are exactly the API's. A section
 * that refuses (a missing permission, a feature that is off) is recorded in `skipped` instead of
 * failing the export; anything else is a bug and is thrown.
 *
 * Deliberately left out: deployments and releases, database/bucket/volume contents, logs, metrics,
 * pool users and invites, audit history, and every secret value (secrets are listed by name).
 */

type Sources = Omit<Core, 'configExport' | 'configImport'>;

export interface ConfigExportOptions {
	/** Limit `projects` to these slugs. Org-level sections are exported either way. */
	projects?: string[];
}

export interface ConfigExport extends ConfigExportHeader {
	projects: Record<string, unknown>[];
	[section: string]: unknown;
	skipped: ConfigExportSkip[];
}

export class ConfigExportService {
	constructor(
		private readonly core: Sources,
		private readonly version: string,
	) {}

	async export(principal: Principal, options: ConfigExportOptions = {}): Promise<ConfigExport> {
		const core = this.core;
		const skipped: ConfigExportSkip[] = [];
		const read = <T>(section: string, fn: () => T): T | undefined => {
			try {
				return fn();
			} catch (error) {
				if (!(error instanceof CoreError)) throw error;
				skipped.push({ section, code: error.code, reason: error.message });
				return undefined;
			}
		};
		const each = <T, R>(section: string, items: T[] | undefined, fn: (item: T) => R): R[] | undefined =>
			items === undefined ? undefined : read(section, () => items.map(fn));
		const org = { type: 'org' as const };

		const wanted = options.projects?.length ? new Set(options.projects) : null;
		const projectViews = read('projects', () => core.projects.list(principal)) ?? [];
		if (wanted)
			for (const slug of wanted)
				if (!projectViews.some((project) => project.slug === slug))
					skipped.push({ section: `projects.${slug}`, code: 'not_found', reason: `Project "${slug}" not found` });

		const projects: Record<string, unknown>[] = [];
		for (const view of projectViews.sort((a, b) => a.slug.localeCompare(b.slug))) {
			if (wanted && !wanted.has(view.slug)) continue;
			const at = (name: string) => `projects.${view.slug}.${name}`;
			const row = read(`projects.${view.slug}`, () => core.projects.requireRow(principal, view.slug));
			if (!row) continue;
			projects.push({
				...view,
				environments: read(at('environments'), () => core.environments.list(principal, row)),
				domains: read(at('domains'), () => core.domains.list(principal, row)),
				workload: read(at('workload'), () => core.workloads.projectSpec(row)),
				function: view.runtime === 'function' ? read(at('function'), () => core.functions.view(principal, row)) : undefined,
				jobs: read(at('jobs'), () => core.jobs.list(principal, row)),
				volumes: read(at('volumes'), () => core.appVolumes.list(principal, row)),
				secrets: read(at('secrets'), () => latestSecrets(core.secrets.list(principal, { projectId: row.id }).filter((s) => s.projectId === row.id))),
				attachments: {
					databases: read(at('attachments.databases'), () => core.databases.attachments(principal, row)),
					storage: read(at('attachments.storage'), () => core.storage.attachments(principal, row)),
					brokers: read(at('attachments.brokers'), () => core.brokers.attachments(principal, row)),
				},
			});
		}

		const iam = read('iam', () => {
			core.iam.require(principal, 'iam:read', org);
			return {
				// Who the user ids below are, so an import can map them by email on another instance.
				members: this.members(principal.orgId),
				roles: core.iam.listRoles(principal.orgId),
				bindings: core.iam.listBindings(principal.orgId),
				groups: core.iam.listGroups(principal.orgId).map((group) => ({ ...group, memberUserIds: this.groupMembers(group.id) })),
				guardrails: read('iam.guardrails', () => core.governance.list(principal)),
				authPolicy: read('iam.authPolicy', () => core.authPolicy.get(principal)),
			};
		});

		const pools = read('userPools', () => core.userPools.list(principal));
		const repositories = read('pipelines', () => core.pipelines.listRepositories(principal));
		const alertRules = read('alertRules', () => core.alerts.listRules(principal));

		const body = {
			projects,
			secrets: read('secrets', () => latestSecrets(core.secrets.list(principal, { projectId: null }).filter((s) => s.projectId === null))),
			databases: read('databases', () => core.databases.list(principal)),
			storage: read('storage', () => core.storage.list(principal)),
			brokers: read('brokers', () => core.brokers.list(principal)),
			iam,
			serviceAccounts: read('serviceAccounts', () => core.serviceAccounts.list(principal)),
			accessKeys: read('accessKeys', () => core.accessKeys.list(principal)),
			federationTrusts: read('federationTrusts', () => core.federation.list(principal)),
			accessPolicies: read('accessPolicies', () => core.accessPolicies.list(principal)),
			// Clients and groups are configuration; pool users and invites are people, not config.
			userPools: each('userPools', pools, (pool) => ({
				...pool,
				clients: read(`userPools.${pool.id}.clients`, () => core.userPools.listClients(principal, pool.id)),
				groups: read(`userPools.${pool.id}.groups`, () => core.userPools.listGroups(principal, pool.id)),
			})),
			logDrains: read('logDrains', () => core.logDrains.list(principal)),
			backupTargets: read('backupTargets', () => core.backupTargets.list(principal)),
			eventRules: read('eventRules', () => core.events.list(principal)),
			// The full rule (query, thresholds, channels), not the summary with live firing state.
			alertRules: each('alertRules', alertRules, (rule) => read(`alertRules.${rule.id}`, () => core.alerts.getRule(principal, rule.id))),
			email: read('email', () => ({
				settings: core.email.orgView(principal),
				domains: read('email.domains', () => core.email.listDomains(principal)),
			})),
			pipelines: each('pipelines', repositories, (repo) => ({
				...repo,
				variables: read(`pipelines.${repo.name}.variables`, () => core.pipelines.listVariables(principal, repo.name)),
				secrets: read(`pipelines.${repo.name}.secrets`, () => core.pipelines.listSecrets(principal, repo.name)),
				environments: read(`pipelines.${repo.name}.environments`, () => core.pipelines.listEnvironments(principal, repo.name)),
				projectLinks: read(`pipelines.${repo.name}.projectLinks`, () => core.pipelines.listProjectLinks(principal, repo.name)),
			})),
			registryCredentials: read('registryCredentials', () => core.registryCredentials.list(principal)),
			forgeConnections: read('forgeConnections', () => core.forges.list(principal)),
			shares: read('shares', () => core.shares.list(principal)),
			templates: read('templates', () => core.templates.list(principal)),
		};

		const orgRow = this.orgRow(principal.orgId);
		// A full read of the org's configuration is worth a trail even though it changes nothing.
		core.audit.record({
			principal,
			action: 'config.export',
			resource: 'org',
			resourceId: principal.orgId,
			args: { projects: projects.length, projectFilter: wanted ? [...wanted].sort() : null, skipped: skipped.map((skip) => skip.section) },
			result: 'ok',
		});
		return {
			apiVersion: CONFIG_EXPORT_VERSION,
			exportedAt: new Date(this.now()).toISOString(),
			platform: { url: this.platform.platformOrigin, contentDomain: this.platform.contentDomain, version: this.version },
			org: { id: principal.orgId, name: orgRow?.name ?? null, slug: orgRow?.slug ?? null },
			projectFilter: wanted ? [...wanted].sort() : null,
			...stripUndefined(body),
			projects: projects.map((project) => stripUndefined(project)),
			skipped,
		};
	}

	/** Org members with their email: the key an import uses to find the same people again. */
	private members(orgId: string): { userId: string; email: string | null; name: string | null; role: string }[] {
		try {
			return this.core.ctx.sqlite
				.query<{ userId: string; email: string | null; name: string | null; role: string }, [string]>(
					'SELECT m.userId AS userId, u.email AS email, u.name AS name, m.role AS role FROM member m LEFT JOIN "user" u ON u.id = m.userId WHERE m.organizationId = ? ORDER BY u.email',
				)
				.all(orgId);
		} catch {
			return [];
		}
	}

	private groupMembers(groupId: string): string[] {
		try {
			return this.core.ctx.sqlite
				.query<{ user_id: string }, [string]>('SELECT user_id FROM iam_group_members WHERE group_id = ? ORDER BY user_id')
				.all(groupId)
				.map((row) => row.user_id);
		} catch {
			return [];
		}
	}

	/** The org's name and slug live in the auth tables, which a bare core database lacks. */
	private orgRow(orgId: string): { name: string | null; slug: string | null } | null {
		try {
			return this.core.ctx.sqlite
				.query<{ name: string | null; slug: string | null }, [string]>('SELECT name, slug FROM organization WHERE id = ?')
				.get(orgId);
		} catch {
			return null;
		}
	}

	private get platform() {
		return this.core.ctx.config;
	}

	private now(): number {
		return this.core.ctx.now();
	}
}

/** `secrets.list` returns every live version; the export lists each name once, at its latest. */
function latestSecrets<T extends { name: string; version: number }>(rows: T[]): T[] {
	const latest = new Map<string, T>();
	for (const row of rows) if ((latest.get(row.name)?.version ?? -1) < row.version) latest.set(row.name, row);
	return [...latest.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Drop keys whose section was skipped (`undefined`) so YAML and JSON agree. */
function stripUndefined<T extends Record<string, unknown>>(value: T): T {
	return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}
