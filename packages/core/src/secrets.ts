import { and, eq, isNull, sql } from 'drizzle-orm';
import { orgKeys, secrets } from '@skiff/db';
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
		requirePermission(principal, 'secret:create');
		if (!/^[A-Z][A-Z0-9_]*$/.test(input.name))
			throw new ValidationError('Secret names must be UPPER_SNAKE_CASE.');
		const type = input.type ?? 'secret';
		const projectId = input.projectId ?? null;
		const latest = this.ctx.db
			.select({ version: secrets.version })
			.from(secrets)
			.where(and(eq(secrets.orgId, principal.orgId), eq(secrets.name, input.name), isNull(secrets.deletedAt)))
			.orderBy(sql`${secrets.version} DESC`)
			.get();
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
			action: 'secret.set',
			resource: 'secret',
			resourceId: id,
			args: { name: input.name, projectId, version, type },
			result: 'ok',
		});
		return {
			id,
			name: input.name,
			type,
			version,
			projectId,
			createdAt: new Date(this.ctx.now()).toISOString(),
		};
	}

	list(principal: Principal, options: { projectId?: string | null } = {}): SecretView[] {
		requirePermission(principal, 'secret:read-metadata');
		const filters = [eq(secrets.orgId, principal.orgId), isNull(secrets.deletedAt)];
		if (options.projectId !== undefined) {
			filters.push(options.projectId === null ? isNull(secrets.projectId) : eq(secrets.projectId, options.projectId));
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

	/** Internal delivery only (tier 2); never exposed by REST/MCP. */
	getValue(orgId: string, name: string, version?: number): { name: string; value: string; version: number } | null {
		const row = this.ctx.db
			.select()
			.from(secrets)
			.where(
				and(
					eq(secrets.orgId, orgId),
					eq(secrets.name, name),
					isNull(secrets.deletedAt),
					version ? eq(secrets.version, version) : sql`1 = 1`,
				),
			)
			.orderBy(sql`${secrets.version} DESC`)
			.get();
		if (!row) return null;
		const key = this.orgKey(orgId);
		const value = new TextDecoder().decode(decrypt(key, row.ciphertext, row.nonce));
		return { name: row.name, value, version: row.version };
	}
}
