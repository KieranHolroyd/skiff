import { eq } from 'drizzle-orm';
import { domains as domainsTable } from '@yoal/db';
import type { Principal } from '@yoal/contracts';
import { NotFoundError } from '../errors.ts';
import type { Core } from '../index.ts';
import type { ImportPlan } from './engine.ts';

/**
 * Shared state for one import: the export document (loosely typed: it is a file from another
 * instance, possibly an older version), the caller, the plan being built, and resolvers that turn
 * the export's old ids into names and names into this instance's ids.
 *
 * Ids from the old instance are never trusted. Every reference is translated through a natural
 * name (project slug, group name, pool name, …) and looked up live at apply time, so a resource
 * that already existed here is used exactly like one this import created.
 */

export type Sources = Omit<Core, 'configExport' | 'configImport'>;
export type Doc = Record<string, unknown>;
export type Item = Record<string, unknown>;

export interface ImportOptions {
	only: Set<string> | null;
	skip: Set<string>;
	projects: Set<string> | null;
	secrets: Record<string, string>;
}

export class ImportContext {
	constructor(
		readonly core: Sources,
		readonly principal: Principal,
		readonly doc: Doc,
		readonly plan: ImportPlan,
		readonly options: ImportOptions,
	) {}

	/** Whether a top-level section takes part in this import. */
	wants(section: string): boolean {
		if (this.options.skip.has(section)) return false;
		return this.options.only === null || this.options.only.has(section);
	}

	wantsProject(slug: string): boolean {
		return this.options.projects === null || this.options.projects.has(slug);
	}

	// ------------------------------------------------------------------ the export document

	items(section: string): Item[] {
		return arr(this.doc[section]);
	}

	projects(): Item[] {
		return this.items('projects').filter((project) => typeof project.slug === 'string');
	}

	iam(): Item {
		return obj(this.doc.iam);
	}

	/** Old project id → slug, from the export. */
	projectSlugById(id: unknown): string | null {
		return str(this.projects().find((project) => project.id === id)?.slug);
	}

	/** Old environment id → its project slug and environment slug. */
	environmentById(id: unknown): { project: string; environment: string } | null {
		for (const project of this.projects())
			for (const env of arr(project.environments))
				if (env.id === id && typeof project.slug === 'string' && typeof env.slug === 'string')
					return { project: project.slug, environment: env.slug };
		return null;
	}

	nameById(section: string, id: unknown, nested?: (doc: Doc) => Item[]): string | null {
		const list = nested ? nested(this.doc) : this.items(section);
		return str(list.find((item) => item.id === id)?.name);
	}

	/** Old user id → email, from `iam.members`. */
	emailByUserId(id: unknown): string | null {
		return str(arr(this.iam().members).find((member) => member.userId === id)?.email);
	}

	// ------------------------------------------------------------------ live lookups (this instance)

	maybe<T>(read: () => T): T | undefined {
		try {
			return read();
		} catch (error) {
			if (error instanceof NotFoundError) return undefined;
			throw error;
		}
	}

	projectRow(slug: string, includeDeleted = false) {
		return this.maybe(() => this.core.projects.requireRow(this.principal, slug, { includeDeleted }));
	}

	requireProject(slug: string) {
		return this.core.projects.requireRow(this.principal, slug);
	}

	environmentRow(projectSlug: string, envSlug: string) {
		const project = this.projectRow(projectSlug);
		return project ? this.core.environments.rows(project.id).find((row) => row.slug === envSlug) : undefined;
	}

	domainTaken(hostname: string): { projectId: string } | undefined {
		return this.core.ctx.db
			.select({ projectId: domainsTable.projectId })
			.from(domainsTable)
			.where(eq(domainsTable.hostname, hostname))
			.get();
	}

	/** A user of this org with that email (case-insensitive), or null. */
	userIdByEmail(email: string | null): string | null {
		if (!email) return null;
		try {
			return (
				this.core.ctx.sqlite
					.query<{ id: string }, [string, string]>(
						'SELECT u.id AS id FROM "user" u JOIN member m ON m.userId = u.id WHERE lower(u.email) = lower(?) AND m.organizationId = ? LIMIT 1',
					)
					.get(email, this.principal.orgId)?.id ?? null
			);
		} catch {
			return null;
		}
	}

	groupId(name: string): string | null {
		return this.core.iam.listGroups(this.principal.orgId).find((group) => group.name === name)?.id ?? null;
	}

	groupHasMember(groupId: string, userId: string): boolean {
		try {
			return !!this.core.ctx.sqlite
				.query<{ n: number }, [string, string]>('SELECT 1 AS n FROM iam_group_members WHERE group_id = ? AND user_id = ?')
				.get(groupId, userId);
		} catch {
			return false;
		}
	}

	serviceAccountId(name: string): string | null {
		return this.maybe(() => this.core.serviceAccounts.list(this.principal).find((sa) => sa.name === name)?.id) ?? null;
	}

	poolId(name: string): string | null {
		return this.maybe(() => this.core.userPools.list(this.principal).find((pool) => pool.name === name)?.id) ?? null;
	}

	customRoleId(name: string): string | null {
		return this.core.iam.listRoles(this.principal.orgId).find((role) => !role.builtIn && role.name === name)?.id ?? null;
	}

	/**
	 * Translate a scope from the export (`{ type, id, projectId }` with old ids) into this
	 * instance's ids, at apply time. Returns a reason string when it cannot be translated.
	 */
	resolveScope(scope: unknown): { scope: Record<string, unknown> } | { problem: string } {
		const ref = obj(scope);
		const type = str(ref.type);
		if (!type || type === 'org') return { scope: { type: 'org' } };
		if (type === 'platform') return { problem: 'platform-scope grants are not part of an org import' };
		if (type === 'project') {
			const slug = this.projectSlugById(ref.id);
			const row = slug ? this.projectRow(slug) : undefined;
			return row ? { scope: { type, id: row.id } } : { problem: `project ${slug ?? String(ref.id)} is not on this instance` };
		}
		if (type === 'environment') {
			const env = this.environmentById(ref.id);
			const project = env ? this.projectRow(env.project) : undefined;
			const row = env ? this.environmentRow(env.project, env.environment) : undefined;
			return project && row
				? { scope: { type, projectId: project.id, id: row.id } }
				: { problem: `environment ${env ? `${env.project}/${env.environment}` : String(ref.id)} is not on this instance` };
		}
		const named: Record<string, () => string | null | undefined> = {
			database: () => {
				const name = this.nameById('databases', ref.id);
				return name ? this.maybe(() => this.core.databases.requireRow(this.principal, name))?.id : null;
			},
			storage: () => {
				const name = this.nameById('storage', ref.id);
				return name ? this.maybe(() => this.core.storage.requireRow(this.principal, name))?.id : null;
			},
			broker: () => {
				const name = this.nameById('brokers', ref.id);
				return name ? this.maybe(() => this.core.brokers.requireRow(this.principal, name))?.id : null;
			},
			userPool: () => {
				const name = this.nameById('userPools', ref.id);
				return name ? this.poolId(name) : null;
			},
			pipelineRepository: () => {
				const name = this.nameById('pipelines', ref.id);
				return name ? this.maybe(() => this.core.pipelines.getRepository(this.principal, name))?.id : null;
			},
		};
		const resolve = named[type];
		if (!resolve) return { problem: `${type}-scope grants point at resources an import does not recreate` };
		const id = resolve();
		if (!id) return { problem: `the ${type} it points at is not on this instance` };
		const out: Record<string, unknown> = { type, id };
		if (ref.projectId) {
			const slug = this.projectSlugById(ref.projectId);
			const row = slug ? this.projectRow(slug) : undefined;
			if (row) out.projectId = row.id;
		}
		return { scope: out };
	}
}

// ---------------------------------------------------------------------- loose readers

export function obj(value: unknown): Item {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Item) : {};
}

export function arr(value: unknown): Item[] {
	return Array.isArray(value) ? value.filter((item): item is Item => !!item && typeof item === 'object' && !Array.isArray(item)) : [];
}

export function str(value: unknown): string | null {
	return typeof value === 'string' && value.length > 0 ? value : null;
}

export function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** Copy the listed keys whose value is not undefined/null (`keepNull` keeps nulls for those keys). */
export function pick(source: Item, keys: readonly string[], keepNull: readonly string[] = []): Item {
	const out: Item = {};
	for (const key of keys) {
		const value = source[key];
		if (value === undefined) continue;
		if (value === null && !keepNull.includes(key)) continue;
		out[key] = value;
	}
	return out;
}

/** Deleted rows in an export are not configuration. */
export function live(items: Item[]): Item[] {
	return items.filter((item) => !item.deletedAt);
}

