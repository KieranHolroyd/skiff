import { and, eq } from 'drizzle-orm';
import { registryCredentials } from '@skiff/db';
import {
	MAX_REGISTRY_CREDENTIALS_PER_ORG,
	parseImageReference,
	registryCredentialCreateSchema,
	registryCredentialUpdateSchema,
	requirePermission,
	type Principal,
	type RegistryAuthEntry,
	type RegistryCredentialCreate,
	type RegistryCredentialUpdate,
	type RegistryCredentialView,
} from '@skiff/contracts';
import type { CoreContext } from './context.ts';
import { ConflictError, NotFoundError, ValidationError } from './errors.ts';
import { newId } from './util.ts';

type CredentialRow = typeof registryCredentials.$inferSelect;

/**
 * Credentials for external container registries (R2, docs/REGISTRY.md §5.2).
 *
 * One credential per registry host per org. The password is sealed with the org key and is
 * returned only to code paths that pull: deploy-time digest resolution and the node activation
 * endpoint, which hands it to the helper as the workload's 0400 `AuthFile=`. Views never carry it.
 *
 * A change does not restart running containers: the auth file matters only when a node pulls,
 * and a workload that failed to pull is re-applied (and re-activated) on the agent's next retry.
 */
export class RegistryCredentialService {
	constructor(private readonly ctx: CoreContext) {}

	list(principal: Principal): RegistryCredentialView[] {
		requirePermission(principal, 'image:pull');
		return this.ctx.db
			.select()
			.from(registryCredentials)
			.where(eq(registryCredentials.orgId, principal.orgId))
			.all()
			.sort((a, b) => a.name.localeCompare(b.name))
			.map(toView);
	}

	create(principal: Principal, raw: RegistryCredentialCreate): RegistryCredentialView {
		requirePermission(principal, 'image:credentials');
		const input = registryCredentialCreateSchema.parse(raw);
		const existing = this.ctx.db
			.select()
			.from(registryCredentials)
			.where(eq(registryCredentials.orgId, principal.orgId))
			.all();
		if (existing.length >= MAX_REGISTRY_CREDENTIALS_PER_ORG)
			throw new ValidationError(`An org can store at most ${MAX_REGISTRY_CREDENTIALS_PER_ORG} registry credentials.`);
		if (existing.some((row) => row.name === input.name))
			throw new ConflictError(`A registry credential named "${input.name}" already exists.`);
		const sameHost = existing.find((row) => row.registry === input.registry);
		if (sameHost)
			throw new ConflictError(
				`"${sameHost.name}" already holds the credential for ${input.registry}. Update it instead.`,
			);
		const now = this.ctx.now();
		const row: CredentialRow = {
			id: newId('rc_'),
			orgId: principal.orgId,
			name: input.name,
			registry: input.registry,
			username: input.username,
			passwordSealed: this.ctx.secrets.seal(principal.orgId, input.password),
			createdBy: principal.userId,
			createdAt: now,
			updatedAt: now,
			lastUsedAt: null,
		};
		this.ctx.db.insert(registryCredentials).values(row).run();
		this.ctx.audit.record({
			principal,
			action: 'registry.credential.create',
			resource: 'registryCredential',
			resourceId: row.id,
			args: { name: row.name, registry: row.registry, username: row.username },
			result: 'ok',
		});
		return toView(row);
	}

	update(principal: Principal, name: string, raw: RegistryCredentialUpdate): RegistryCredentialView {
		requirePermission(principal, 'image:credentials');
		const input = registryCredentialUpdateSchema.parse(raw);
		const row = this.require(principal.orgId, name);
		if (input.registry && input.registry !== row.registry) {
			const clash = this.ctx.db
				.select({ name: registryCredentials.name })
				.from(registryCredentials)
				.where(and(eq(registryCredentials.orgId, principal.orgId), eq(registryCredentials.registry, input.registry)))
				.get();
			if (clash) throw new ConflictError(`"${clash.name}" already holds the credential for ${input.registry}.`);
		}
		const changes: Partial<CredentialRow> = { updatedAt: this.ctx.now() };
		if (input.registry) changes.registry = input.registry;
		if (input.username) changes.username = input.username;
		if (input.password) changes.passwordSealed = this.ctx.secrets.seal(principal.orgId, input.password);
		this.ctx.db.update(registryCredentials).set(changes).where(eq(registryCredentials.id, row.id)).run();
		this.ctx.audit.record({
			principal,
			action: 'registry.credential.update',
			resource: 'registryCredential',
			resourceId: row.id,
			args: {
				name: row.name,
				...(input.registry ? { registry: input.registry } : {}),
				...(input.username ? { username: input.username } : {}),
				password: Boolean(input.password),
			},
			result: 'ok',
		});
		return toView({ ...row, ...changes });
	}

	remove(principal: Principal, name: string): void {
		requirePermission(principal, 'image:credentials');
		const row = this.require(principal.orgId, name);
		this.ctx.db.delete(registryCredentials).where(eq(registryCredentials.id, row.id)).run();
		this.ctx.audit.record({
			principal,
			action: 'registry.credential.delete',
			resource: 'registryCredential',
			resourceId: row.id,
			args: { name: row.name, registry: row.registry },
			result: 'ok',
		});
	}

	/** The org's credential for the registry `image` lives on, decrypted; null when it has none. */
	loginForImage(orgId: string, image: string): { username: string; password: string } | null {
		const row = this.rowForImage(orgId, image);
		if (!row) return null;
		return { username: row.username, password: this.ctx.secrets.open(orgId, row.passwordSealed) };
	}

	/**
	 * Auth entries for a workload's activation (R2). Records the use, so the dashboard can show
	 * which credentials are live. Empty for local images and registries without a credential.
	 */
	authForImage(orgId: string, image: string | undefined, desiredId?: string): RegistryAuthEntry[] {
		if (!image) return [];
		// Skiff's own registry: a per-workload login valid only for this image's repository (G1).
		if (desiredId && this.ctx.registry.isOwnImage(image)) return [this.ctx.registry.workloadLogin(desiredId)];
		const entries: RegistryAuthEntry[] = [];
		const row = this.rowForImage(orgId, image);
		if (row) {
			this.ctx.db
				.update(registryCredentials)
				.set({ lastUsedAt: this.ctx.now() })
				.where(eq(registryCredentials.id, row.id))
				.run();
			entries.push({ registry: row.registry, username: row.username, password: this.ctx.secrets.open(orgId, row.passwordSealed) });
		}
		// G4: an auth file replaces root's, so a mirrored image also needs the workload's mirror login.
		const mirror = this.ctx.registry.mirrorForNodes();
		const upstream = parseImageReference(image)?.registry;
		if (desiredId && entries.length > 0 && mirror && upstream && (mirror.upstreams as string[]).includes(upstream))
			entries.push(this.ctx.registry.workloadLogin(desiredId));
		return entries;
	}

	private rowForImage(orgId: string, image: string): CredentialRow | null {
		const parsed = parseImageReference(image);
		if (!parsed || parsed.registry === 'localhost') return null;
		return (
			this.ctx.db
				.select()
				.from(registryCredentials)
				.where(and(eq(registryCredentials.orgId, orgId), eq(registryCredentials.registry, parsed.registry)))
				.get() ?? null
		);
	}

	private require(orgId: string, name: string): CredentialRow {
		const row = this.ctx.db
			.select()
			.from(registryCredentials)
			.where(and(eq(registryCredentials.orgId, orgId), eq(registryCredentials.name, name)))
			.get();
		if (!row) throw new NotFoundError('Registry credential');
		return row;
	}
}

function toView(row: CredentialRow): RegistryCredentialView {
	return {
		id: row.id,
		name: row.name,
		registry: row.registry,
		username: row.username,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		lastUsedAt: row.lastUsedAt ?? null,
	};
}
