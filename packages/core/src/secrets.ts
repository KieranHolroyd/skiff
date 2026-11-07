import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { orgKeys, projects, secrets } from '@skiff/db';
import { requirePermission, type Principal } from '@skiff/contracts';
import type { CoreContext } from './context.ts';
import { NotFoundError, ValidationError } from './errors.ts';
import { decrypt, encrypt, newId, randomBytes } from './util.ts';

export interface SecretView {
	id: string;
	name: string;
	type: 'secret' | 'env';
	version: number;
	projectId: string | null;
	createdAt: string;
}

/**
 * Envelope encryption (D18): per-org data keys wrapped by the master key (systemd-creds in
 * production). Secrets are write-only; values are only decrypted for delivery at activation.
 */
export class SecretService {
	constructor(private readonly ctx: CoreContext) {}

	private orgKey(orgId: string): Uint8Array {
		const existing = this.ctx.db.select().from(orgKeys).where(eq(orgKeys.orgId, orgId)).get();
		if (existing) {
			const wrapped = Buffer.from(existing.wrappedKey, 'base64');
			const nonce = wrapped.subarray(0, 12);
			return decrypt(this.ctx.config.masterKey, wrapped.subarray(12).toString('base64'), nonce.toString('base64'));
		}
		const key = randomBytes(32);
		const encrypted = encrypt(this.ctx.config.masterKey, key);
		this.ctx.db
			.insert(orgKeys)
			.values({
				orgId,
				wrappedKey: Buffer.concat([Buffer.from(encrypted.nonce, 'base64'), Buffer.from(encrypted.ciphertext, 'base64')]).toString('base64'),
			})
			.run();
		return key;
	}

	async set(
		principal: Principal,
		input: { name: string; value: string; projectId?: string | null; type?: 'secret' | 'env' },
	): Promise<SecretView> {
		if (!/^[A-Z][A-Z0-9_]*$/.test(input.name))
			throw new ValidationError('Secret names must be UPPER_SNAKE_CASE.');
		const type = input.type ?? 'secret';
		const projectId = input.projectId ?? null;
		// A new name needs `secret:create`; a new version of a live one needs `secret:update`.
		const latest = this.requireWrite(principal, { name: input.name, projectId });
		if (projectId !== null) {
			const project = this.ctx.db
				.select({ id: projects.id })
				.from(projects)
				.where(and(eq(projects.id, projectId), eq(projects.orgId, principal.orgId)))
				.get();
			if (!project) throw new NotFoundError('Project');
		}
		const version = (latest?.version ?? 0) + 1;
		const key = this.orgKey(principal.orgId);
		const encrypted = encrypt(key, new TextEncoder().encode(input.value));
		const id = newId('sec_');
		this.ctx.db
			.insert(secrets)
			.values({
				id,
				orgId: principal.orgId,
				projectId,
				name: input.name,
				type,
				version,
				ciphertext: encrypted.ciphertext,
				nonce: encrypted.nonce,
				createdBy: principal.userId,
			})
			.run();
		this.ctx.audit.record({
			principal,
			action: latest ? 'secret.update' : 'secret.create',
			resource: 'secret',
			resourceId: id,
			args: { name: input.name, projectId, version, type },
			result: 'ok',
		});
		// Workloads referencing this name restart with the new version (activation fingerprint).
		this.ctx.projects.bump(principal.orgId);
		return {
			id,
			name: input.name,
			type,
			version,
			projectId,
			createdAt: new Date(this.ctx.now()).toISOString(),
		};
	}

	/**
	 * Whether `name` already has a live version in this scope (project, or `null` for the
	 * organisation). Versions count within one scope: a project's FOO and the organisation's FOO
	 * are separate secrets.
	 */
	latest(orgId: string, projectId: string | null, name: string): { version: number } | null {
		return (
			this.ctx.db
				.select({ version: secrets.version })
				.from(secrets)
				.where(and(...this.scopeFilters(orgId, projectId, name)))
				.orderBy(sql`${secrets.version} DESC`)
				.get() ?? null
		);
	}

	/**
	 * The permission a write needs (RBAC `secret:*`): `secret:create` to add a name to a scope,
	 * `secret:update` to store a new version of one that is live there. Throws when missing;
	 * returns the latest live version (null for a new secret). Callers that write several secrets
	 * check them all first so a refusal never leaves half of them written.
	 */
	requireWrite(principal: Principal, input: { name: string; projectId?: string | null }): { version: number } | null {
		const latest = this.latest(principal.orgId, input.projectId ?? null, input.name);
		requirePermission(principal, latest ? 'secret:update' : 'secret:create');
		return latest;
	}

	/**
	 * `projectId` lists exactly one scope (null = organisation-wide). `visibleTo` lists what a
	 * project's workload can reference: the organisation's secrets plus that project's own.
	 */
	list(principal: Principal, options: { projectId?: string | null; visibleTo?: string } = {}): SecretView[] {
		requirePermission(principal, 'secret:read-metadata');
		const filters = [eq(secrets.orgId, principal.orgId), isNull(secrets.deletedAt)];
		if (options.projectId !== undefined) {
			filters.push(options.projectId === null ? isNull(secrets.projectId) : eq(secrets.projectId, options.projectId));
		}
		if (options.visibleTo !== undefined) {
			filters.push(or(isNull(secrets.projectId), eq(secrets.projectId, options.visibleTo))!);
		}
		return this.ctx.db
			.select({
				id: secrets.id,
				name: secrets.name,
				type: secrets.type,
				version: secrets.version,
				projectId: secrets.projectId,
				createdAt: secrets.createdAt,
			})
			.from(secrets)
			.where(and(...filters))
			.all()
			.map((row) => ({
				id: row.id,
				name: row.name,
				type: row.type as 'secret' | 'env',
				version: row.version,
				projectId: row.projectId,
				createdAt: new Date(row.createdAt).toISOString(),
			}));
	}

	async delete(principal: Principal, id: string): Promise<void> {
		requirePermission(principal, 'secret:delete');
		const row = this.ctx.db
			.select()
			.from(secrets)
			.where(and(eq(secrets.id, id), eq(secrets.orgId, principal.orgId)))
			.get();
		if (!row) throw new NotFoundError('Secret');
		this.ctx.db.update(secrets).set({ deletedAt: this.ctx.now() }).where(eq(secrets.id, id)).run();
		this.ctx.audit.record({
			principal,
			action: 'secret.delete',
			resource: 'secret',
			resourceId: id,
			args: { name: row.name, version: row.version },
			result: 'ok',
		});
		this.ctx.projects.bump(principal.orgId);
	}

	/** Seal an internal value (database credentials, D58) with the org data key: `nonce.ciphertext`. */
	seal(orgId: string, value: string): string {
		const encrypted = encrypt(this.orgKey(orgId), new TextEncoder().encode(value));
		return `${encrypted.nonce}.${encrypted.ciphertext}`;
	}

	/** Open a value produced by `seal`. */
	open(orgId: string, sealed: string): string {
		const [nonce, ciphertext] = sealed.split('.');
		if (!nonce || !ciphertext) throw new ValidationError('Sealed value is malformed.');
		return new TextDecoder().decode(decrypt(this.orgKey(orgId), ciphertext, nonce));
	}

	/**
	 * Resolve a secret reference for a project's workload: the project's own secret wins over an
	 * organisation-wide one with the same name; another project's secrets are never visible.
	 * A pinned version applies within the scope that wins.
	 */
	resolve(orgId: string, projectId: string | null, name: string): { scope: 'project' | 'org'; versions: number[] } | null {
		for (const scope of projectId === null ? [null] : [projectId, null]) {
			const rows = this.ctx.db
				.select({ version: secrets.version })
				.from(secrets)
				.where(and(...this.scopeFilters(orgId, scope, name)))
				.orderBy(sql`${secrets.version} DESC`)
				.all();
			if (rows.length > 0) return { scope: scope === null ? 'org' : 'project', versions: rows.map((row) => row.version) };
		}
		return null;
	}

	/** Internal delivery only (tier 2); never exposed by REST/MCP. */
	getValue(
		orgId: string,
		name: string,
		version?: number,
		projectId: string | null = null,
	): { name: string; value: string; version: number } | null {
		const resolved = this.resolve(orgId, projectId, name);
		if (!resolved) return null;
		const scope = resolved.scope === 'project' ? projectId : null;
		const row = this.ctx.db
			.select()
			.from(secrets)
			.where(and(...this.scopeFilters(orgId, scope, name), version ? eq(secrets.version, version) : sql`1 = 1`))
			.orderBy(sql`${secrets.version} DESC`)
			.get();
		if (!row) return null;
		const key = this.orgKey(orgId);
		const value = new TextDecoder().decode(decrypt(key, row.ciphertext, row.nonce));
		return { name: row.name, value, version: row.version };
	}

	private scopeFilters(orgId: string, projectId: string | null, name: string) {
		return [
			eq(secrets.orgId, orgId),
			projectId === null ? isNull(secrets.projectId) : eq(secrets.projectId, projectId),
			eq(secrets.name, name),
			isNull(secrets.deletedAt),
		];
	}
}
