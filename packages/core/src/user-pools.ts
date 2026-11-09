/**
 * Managed user pools (IAM.md I26–I29, §11.2).
 *
 * A pool is an org resource like a database, but its purpose is authentication for one deployed
 * app's own end users. This slice owns the pool row, its OIDC clients, and the public discovery
 * and JWKS documents. It deliberately does **not** implement users, passwords, sessions, hosted
 * sign-in pages, MFA or email: those belong to the native `skiff-identity` engine (I27), which
 * runs as its own process with its own SQLite file per pool. The engine seam is recorded below so
 * the control plane never pretends it is already hosting users.
 *
 * Signing is the one piece that exists today: each pool gets a key in the platform ring with
 * purpose `pool:<id>` (IAM.md I15, §7.3). Discovery and JWKS are public, unauthenticated reads;
 * every write is a normal IAM permission check on the pool resource.
 */
import {
	USER_POOL_AUTH_BINDING,
	userPoolAttachSchema,
	userPoolClientCreateSchema,
	userPoolCreateSchema,
	userPoolDefaultEnvPrefix,
	userPoolEnvNames,
	userPoolUpdateSchema,
	type FunctionRuntimeBinding,
	type Permission,
	type Principal,
	type UserPoolAttach,
	type UserPoolAttachmentView,
	type UserPoolClientCreate,
	type UserPoolClientCreated,
	type UserPoolClientView,
	type UserPoolCreate,
	type UserPoolEngineId,
	type UserPoolGroupMemberView,
	type UserPoolGroupView,
	type UserPoolJwks,
	type UserPoolOidcDiscovery,
	type UserPoolSignupMode,
	type UserPoolTheme,
	type UserPoolUpdate,
	type UserPoolView
} from '@skiff/contracts';
import type { CoreContext } from './context.ts';
import type { ProjectRow } from './projects.ts';
import type {
	UserPoolInviteCreated,
	UserPoolInviteView,
	UserPoolUserView
} from './user-pool-engine.ts';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from './errors.ts';
import { newId, parseJson, randomToken, sha256Hex } from './util.ts';

/** The pool's own signing-key purpose; the platform JWKS excludes `pool:*` (IAM.md §7.3). */
export function userPoolSigningPurpose(poolId: string): `pool:${string}` {
	return `pool:${poolId}`;
}

/**
 * The per-pool "verify email before sign-in" switch. Stored as a platform setting rather than a
 * column because 0097 is the frozen engine schema; an `invite` pool is always required regardless.
 */
export function userPoolRequireEmailVerificationKey(poolId: string): string {
	return `user_pool.${poolId}.require_email_verification`;
}

/** The per-pool "ask every user to enrol TOTP MFA" switch; a settings row like the one above. */
export function userPoolMfaRequiredKey(poolId: string): string {
	return `user_pool.${poolId}.mfa_required`;
}

/**
 * The public issuer for a pool. The id, not the display name, keeps two organisations with a
 * pool called "shop" from colliding; a verified custom domain can replace it later.
 */
export function userPoolIssuer(contentDomain: string, poolId: string): string {
	const domain = contentDomain.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
	return `https://auth.${domain}/${poolId}`;
}

/**
 * The engine seam (IAM.md I27). The native engine ships first; managed Keycloak and Authentik are
 * later registry entries. An engine owns the tenant's users, sessions, hosted pages and data file.
 * `implemented` is false until `skiff-agent identity` exists, so the dashboard can say so honestly.
 */
export interface UserPoolEngine {
	readonly id: UserPoolEngineId;
	readonly label: string;
	/** True once a process exists that can host users for a pool. */
	readonly implemented: boolean;
	/** What the engine owns, for documentation and future provisioning code. */
	readonly owns: readonly ('users' | 'sessions' | 'hosted-sign-in' | 'mfa' | 'social-login')[];
}

export const USER_POOL_ENGINE_IMPLEMENTATIONS: Record<UserPoolEngineId, UserPoolEngine> = {
	'skiff-identity': {
		id: 'skiff-identity',
		label: 'Skiff Identity',
		implemented: false,
		owns: ['users', 'sessions', 'hosted-sign-in', 'mfa', 'social-login']
	}
};

interface UserPoolRow {
	id: string;
	org_id: string;
	name: string;
	description: string;
	engine: string;
	issuer: string;
	signing_key_id: string | null;
	signup_mode: string;
	theme_json: string;
	created_by: string;
	created_at: number;
	updated_at: number;
	disabled_at: number | null;
}

interface UserPoolClientRow {
	id: string;
	pool_id: string;
	name: string;
	client_id: string;
	client_secret_sealed: string | null;
	redirect_uris_json: string;
	public: number;
	created_at: number;
}

interface UserPoolAttachmentRow {
	id: string;
	org_id: string;
	pool_id: string;
	client_row_id: string;
	project_id: string;
	env_prefix: string;
	created_by: string;
	created_at: number;
	pool_name: string;
	issuer: string;
	client_name: string;
	client_id: string;
	client_secret_sealed: string | null;
	client_public: number;
	project_slug: string;
}

/** The public part of a pool that a hosted page may show before anybody signs in. */
export interface UserPoolPublicInfo {
	id: string;
	name: string;
	description: string;
	issuer: string;
	signupMode: UserPoolSignupMode;
	/** Password sign-in waits for email verification. Always true for an invite-only pool. */
	requireEmailVerification: boolean;
	/** The pool asks every user to enrol TOTP MFA. */
	mfaRequired: boolean;
	theme: UserPoolTheme;
}

export class UserPoolService {
	constructor(private readonly ctx: CoreContext) {}

	// ---------------------------------------------------------------- reads

	/** Pools the caller may read. An org grant covers every pool; a pool grant covers one. */
	list(principal: Principal): UserPoolView[] {
		if (!this.canReadAny(principal)) throw new ForbiddenError('userPool:read');
		const orgWide = this.ctx.iam.can(principal, 'userPool:read', { type: 'org' });
		return this.#rows(principal.orgId)
			.filter(
				(row) =>
					orgWide ||
					this.ctx.iam.can(principal, 'userPool:read', { type: 'userPool', id: row.id })
			)
			.map((row) => this.#view(row));
	}

	/** Whether any pool is readable, for the settings page's 403 rather than a misleading empty list. */
	canReadAny(principal: Principal): boolean {
		if (this.ctx.iam.can(principal, 'userPool:read', { type: 'org' })) return true;
		return this.#rows(principal.orgId).some((row) =>
			this.ctx.iam.can(principal, 'userPool:read', { type: 'userPool', id: row.id })
		);
	}

	get(principal: Principal, id: string): UserPoolView {
		const row = this.#row(principal, id);
		this.#require(principal, 'userPool:read', row);
		return this.#view(row);
	}

	listClients(principal: Principal, poolId: string): UserPoolClientView[] {
		const row = this.#row(principal, poolId);
		this.#require(principal, 'userPool:read', row);
		return this.#clients(row.id).map(clientView);
	}

	/** Theme and signup mode for the hosted pages; no authentication, like discovery. */
	publicInfo(poolId: string): UserPoolPublicInfo {
		const row = this.#publicRow(poolId);
		return {
			id: row.id,
			name: row.name,
			description: row.description,
			issuer: row.issuer,
			signupMode: row.signup_mode as UserPoolSignupMode,
			requireEmailVerification: this.#requireEmailVerification(row),
			mfaRequired: this.#mfaRequired(row),
			theme: parseTheme(row.theme_json)
		};
	}

	// ---------------------------------------------------------------- user administration

	listUsers(principal: Principal, poolId: string): UserPoolUserView[] {
		const row = this.#row(principal, poolId);
		this.#require(principal, 'userPool:manage-users', row);
		return this.ctx.userPoolEngine.listUsers(row.id);
	}

	disableUser(principal: Principal, poolId: string, userId: string, disabled = true): UserPoolUserView {
		const row = this.#row(principal, poolId);
		this.#require(principal, 'userPool:manage-users', row);
		const user = this.ctx.userPoolEngine.setUserDisabled(row.id, userId, disabled);
		this.ctx.audit.record({
			principal,
			action: disabled ? 'user_pool.user.disable' : 'user_pool.user.enable',
			resource: 'user_pool_user',
			resourceId: user.id,
			args: { poolId: row.id, pool: row.name, email: user.email },
			result: 'ok'
		});
		return user;
	}

	deleteUser(principal: Principal, poolId: string, userId: string): void {
		const row = this.#row(principal, poolId);
		this.#require(principal, 'userPool:manage-users', row);
		const user = this.ctx.userPoolEngine.user(row.id, userId);
		if (!this.ctx.userPoolEngine.deleteUser(row.id, userId)) throw new NotFoundError('User pool user');
		this.ctx.audit.record({
			principal,
			action: 'user_pool.user.delete',
			resource: 'user_pool_user',
			resourceId: user.id,
			args: { poolId: row.id, pool: row.name, email: user.email },
			result: 'ok'
		});
	}

	inviteUser(principal: Principal, poolId: string, email: string): UserPoolInviteCreated {
		const row = this.#row(principal, poolId);
		this.#require(principal, 'userPool:manage-users', row);
		const created = this.ctx.userPoolEngine.createInvite(row.id, email, {
			createdBy: principal.userId
		});
		this.ctx.audit.record({
			principal,
			action: 'user_pool.user.invite',
			resource: 'user_pool_invite',
			resourceId: created.invite.id,
			args: { poolId: row.id, pool: row.name, email: created.invite.email },
			result: 'ok'
		});
		return created;
	}

	listInvites(principal: Principal, poolId: string): UserPoolInviteView[] {
		const row = this.#row(principal, poolId);
		this.#require(principal, 'userPool:manage-users', row);
		return this.ctx.userPoolEngine.listInvites(row.id);
	}

	// ---------------------------------------------------------------- groups

	listGroups(principal: Principal, poolId: string): UserPoolGroupView[] {
		const row = this.#row(principal, poolId);
		this.#require(principal, 'userPool:manage-users', row);
		return this.ctx.userPoolEngine.listGroups(row.id);
	}

	listGroupMembers(principal: Principal, poolId: string, groupId: string): UserPoolGroupMemberView[] {
		const row = this.#row(principal, poolId);
		this.#require(principal, 'userPool:manage-users', row);
		return this.ctx.userPoolEngine.listGroupMembers(row.id, groupId);
	}

	createGroup(principal: Principal, poolId: string, name: string): UserPoolGroupView {
		const row = this.#row(principal, poolId);
		this.#require(principal, 'userPool:manage-users', row);
		const group = this.ctx.userPoolEngine.createGroup(row.id, name);
		this.ctx.audit.record({
			principal,
			action: 'user_pool.group.create',
			resource: 'user_pool_group',
			resourceId: group.id,
			args: { poolId: row.id, pool: row.name, name: group.name },
			result: 'ok'
		});
		return group;
	}

	renameGroup(principal: Principal, poolId: string, groupId: string, name: string): UserPoolGroupView {
		const row = this.#row(principal, poolId);
		this.#require(principal, 'userPool:manage-users', row);
		const group = this.ctx.userPoolEngine.renameGroup(row.id, groupId, name);
		this.ctx.audit.record({
			principal,
			action: 'user_pool.group.rename',
			resource: 'user_pool_group',
			resourceId: group.id,
			args: { poolId: row.id, pool: row.name, name: group.name },
			result: 'ok'
		});
		return group;
	}

	deleteGroup(principal: Principal, poolId: string, groupId: string): void {
		const row = this.#row(principal, poolId);
		this.#require(principal, 'userPool:manage-users', row);
		if (!this.ctx.userPoolEngine.deleteGroup(row.id, groupId))
			throw new NotFoundError('User pool group');
		this.ctx.audit.record({
			principal,
			action: 'user_pool.group.delete',
			resource: 'user_pool_group',
			resourceId: groupId,
			args: { poolId: row.id, pool: row.name },
			result: 'ok'
		});
	}

	addGroupMember(principal: Principal, poolId: string, groupId: string, userId: string): void {
		const row = this.#row(principal, poolId);
		this.#require(principal, 'userPool:manage-users', row);
		this.ctx.userPoolEngine.addGroupMember(row.id, groupId, userId);
		this.ctx.audit.record({
			principal,
			action: 'user_pool.group.member.add',
			resource: 'user_pool_group',
			resourceId: groupId,
			args: { poolId: row.id, pool: row.name, userId },
			result: 'ok'
		});
	}

	removeGroupMember(principal: Principal, poolId: string, groupId: string, userId: string): void {
		const row = this.#row(principal, poolId);
		this.#require(principal, 'userPool:manage-users', row);
		if (!this.ctx.userPoolEngine.removeGroupMember(row.id, groupId, userId))
			throw new NotFoundError('User pool group member');
		this.ctx.audit.record({
			principal,
			action: 'user_pool.group.member.remove',
			resource: 'user_pool_group',
			resourceId: groupId,
			args: { poolId: row.id, pool: row.name, userId },
			result: 'ok'
		});
	}

	// ---------------------------------------------------------------- lifecycle

	async create(principal: Principal, raw: UserPoolCreate): Promise<UserPoolView> {
		this.ctx.iam.require(principal, 'userPool:create', { type: 'org' });
		const input = userPoolCreateSchema.parse(raw);
		const existing = this.ctx.sqlite
			.query<{ id: string }, [string, string]>(
				'SELECT id FROM user_pools WHERE org_id = ? AND name = ?'
			)
			.get(principal.orgId, input.name);
		if (existing) throw new ConflictError(`A user pool named "${input.name}" already exists.`);

		const id = newId('up_');
		const issuer = userPoolIssuer(this.ctx.config.contentDomain, id);
		// Create the ring entry now so `signing_key_id` is never a guess. The private key never
		// leaves the control plane; discovery publishes only the public half.
		const key = await this.ctx.signingKeys.ensure(userPoolSigningPurpose(id));
		const now = this.ctx.now();
		try {
			this.ctx.sqlite.run(
				`INSERT INTO user_pools
				   (id, org_id, name, description, engine, issuer, signing_key_id, signup_mode, theme_json,
				    created_by, created_at, updated_at, disabled_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
				[
					id,
					principal.orgId,
					input.name,
					input.description ?? '',
					input.engine,
					issuer,
					key.kid,
					input.signupMode,
					JSON.stringify(input.theme ?? {}),
					principal.userId,
					now,
					now
				]
			);
		} catch (cause) {
			// The issuer is unique as a second line of defence; surface it as a normal conflict.
			if (cause instanceof Error && /UNIQUE/i.test(cause.message))
				throw new ConflictError(`A user pool named "${input.name}" already exists.`);
			throw cause;
		}
		if (input.requireEmailVerification) this.#setRequireEmailVerification(id, true);
		if (input.mfaRequired) this.#setMfaRequired(id, true);
		this.ctx.audit.record({
			principal,
			action: 'user_pool.create',
			resource: 'user_pool',
			resourceId: id,
			args: {
				name: input.name,
				engine: input.engine,
				signupMode: input.signupMode,
				requireEmailVerification: input.requireEmailVerification === true,
				mfaRequired: input.mfaRequired === true,
				issuer,
				signingKeyId: key.kid
			},
			result: 'ok'
		});
		return this.#view(this.#rowById(id));
	}

	update(principal: Principal, id: string, raw: UserPoolUpdate): UserPoolView {
		const row = this.#row(principal, id);
		this.#require(principal, 'userPool:update', row);
		const patch = userPoolUpdateSchema.parse(raw);
		const name = patch.name ?? row.name;
		const description = patch.description ?? row.description;
		const signupMode = (patch.signupMode ?? row.signup_mode) as UserPoolSignupMode;
		const theme = patch.theme === undefined ? parseTheme(row.theme_json) : patch.theme;
		const requireEmailVerification =
			signupMode === 'invite' ||
			(patch.requireEmailVerification ?? this.#requireEmailVerification(row));
		const mfaRequired = patch.mfaRequired ?? this.#mfaRequired(row);
		const disabledAt =
			patch.disabled === undefined
				? row.disabled_at
				: patch.disabled
					? (row.disabled_at ?? this.ctx.now())
					: null;

		if (name !== row.name) {
			const taken = this.ctx.sqlite
				.query<{ id: string }, [string, string, string]>(
					'SELECT id FROM user_pools WHERE org_id = ? AND name = ? AND id != ?'
				)
				.get(principal.orgId, name, row.id);
			if (taken) throw new ConflictError(`A user pool named "${name}" already exists.`);
		}

		const unchanged =
			name === row.name &&
			description === row.description &&
			signupMode === row.signup_mode &&
			requireEmailVerification === this.#requireEmailVerification(row) &&
			mfaRequired === this.#mfaRequired(row) &&
			disabledAt === row.disabled_at &&
			JSON.stringify(theme) === JSON.stringify(parseTheme(row.theme_json));
		if (unchanged) return this.#view(row);

		if (patch.requireEmailVerification !== undefined)
			this.#setRequireEmailVerification(row.id, patch.requireEmailVerification);
		if (patch.mfaRequired !== undefined) this.#setMfaRequired(row.id, patch.mfaRequired);
		this.ctx.sqlite.run(
			`UPDATE user_pools
			    SET name = ?, description = ?, signup_mode = ?, theme_json = ?, disabled_at = ?, updated_at = ?
			  WHERE id = ? AND org_id = ?`,
			[
				name,
				description,
				signupMode,
				JSON.stringify(theme),
				disabledAt,
				this.ctx.now(),
				row.id,
				principal.orgId
			]
		);
		this.ctx.audit.record({
			principal,
			action: 'user_pool.update',
			resource: 'user_pool',
			resourceId: row.id,
			args: {
				name,
				description,
				signupMode,
				requireEmailVerification,
				mfaRequired,
				disabled: disabledAt !== null,
				...(row.name !== name ? { previousName: row.name } : {})
			},
			result: 'ok'
		});
		return this.#view(this.#rowById(row.id));
	}

	delete(principal: Principal, id: string): void {
		const row = this.#row(principal, id);
		this.#require(principal, 'userPool:delete', row);
		const attached = this.attachmentsOf(row.id);
		if (attached.length > 0)
			throw new ConflictError(
				`User pool "${row.name}" is attached to ${attached.map((item) => item.projectSlug).join(', ')}. Detach it first.`
			);
		this.ctx.sqlite.transaction(() => {
			this.ctx.userPoolEngine.purgePool(row.id);
			this.ctx.sqlite.run('DELETE FROM user_pool_clients WHERE pool_id = ?', [row.id]);
			this.ctx.sqlite.run('DELETE FROM user_pools WHERE id = ? AND org_id = ?', [
				row.id,
				principal.orgId
			]);
		})();
		this.ctx.audit.record({
			principal,
			action: 'user_pool.delete',
			resource: 'user_pool',
			resourceId: row.id,
			args: { name: row.name },
			result: 'ok'
		});
	}

	// ---------------------------------------------------------------- clients

	createClient(
		principal: Principal,
		poolId: string,
		raw: UserPoolClientCreate
	): UserPoolClientCreated {
		const pool = this.#row(principal, poolId);
		this.#require(principal, 'userPool:credentials', pool);
		const input = userPoolClientCreateSchema.parse(raw);
		const taken = this.ctx.sqlite
			.query<{ id: string }, [string, string]>(
				'SELECT id FROM user_pool_clients WHERE pool_id = ? AND name = ?'
			)
			.get(pool.id, input.name);
		if (taken)
			throw new ConflictError(`A client named "${input.name}" already exists in this pool.`);

		const id = newId('upcc_');
		const clientId = newId('upc_');
		const clientSecret = input.public ? null : randomToken(32);
		const now = this.ctx.now();
		this.ctx.sqlite.run(
			`INSERT INTO user_pool_clients
			   (id, pool_id, name, client_id, client_secret_sealed, redirect_uris_json, public, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				pool.id,
				input.name,
				clientId,
				clientSecret ? this.ctx.secrets.seal(pool.org_id, clientSecret) : null,
				JSON.stringify(input.redirectUris),
				input.public ? 1 : 0,
				now
			]
		);
		this.ctx.audit.record({
			principal,
			action: 'user_pool.client.create',
			resource: 'user_pool_client',
			resourceId: id,
			args: {
				poolId: pool.id,
				pool: pool.name,
				name: input.name,
				clientId,
				public: input.public,
				redirectUris: input.redirectUris
			},
			result: 'ok'
		});
		return { client: clientView(this.#clientById(pool.id, id)), clientSecret };
	}

	deleteClient(principal: Principal, poolId: string, clientIdOrRowId: string): void {
		const pool = this.#row(principal, poolId);
		this.#require(principal, 'userPool:credentials', pool);
		const client = this.ctx.sqlite
			.query<UserPoolClientRow, [string, string, string]>(
				`SELECT * FROM user_pool_clients
				  WHERE pool_id = ? AND (id = ? OR client_id = ?)`
			)
			.get(pool.id, clientIdOrRowId, clientIdOrRowId);
		if (!client) throw new NotFoundError('User pool client');
		const attached = this.ctx.sqlite
			.query<{ project_slug: string }, [string]>(
				`SELECT p.slug AS project_slug
				   FROM user_pool_attachments a JOIN projects p ON p.id = a.project_id
				  WHERE a.client_row_id = ?`
			)
			.all(client.id);
		if (attached.length > 0)
			throw new ConflictError(
				`Client "${client.name}" is attached to ${attached.map((item) => item.project_slug).join(', ')}. Detach it first.`
			);
		this.ctx.sqlite.run('DELETE FROM user_pool_clients WHERE id = ? AND pool_id = ?', [
			client.id,
			pool.id
		]);
		this.ctx.audit.record({
			principal,
			action: 'user_pool.client.delete',
			resource: 'user_pool_client',
			resourceId: client.id,
			args: { poolId: pool.id, pool: pool.name, name: client.name, clientId: client.client_id },
			result: 'ok'
		});
	}

	// ---------------------------------------------------------------- attachments

	/** Pools attached to one project, with the env prefix and client each injects. */
	attachments(principal: Principal, project: ProjectRow): UserPoolAttachmentView[] {
		if (!this.canReadAny(principal)) throw new ForbiddenError('userPool:read');
		return this.#attachmentRows(project.id)
			.filter((row) => this.ctx.iam.can(principal, 'userPool:read', { type: 'userPool', id: row.pool_id }))
			.map(attachmentView);
	}

	/**
	 * Attach a pool to a project like a database. The client must be confidential: its sealed
	 * secret is opened only at activation, so no secret enters desired state or a plain env row.
	 */
	attach(
		principal: Principal,
		project: ProjectRow,
		raw: UserPoolAttach
	): { attachment: UserPoolAttachmentView } {
		this.ctx.iam.require(principal, 'project:update', { type: 'project', id: project.id });
		const input = userPoolAttachSchema.parse(raw);
		if (project.runtime === 'static')
			throw new ValidationError(
				`Project "${project.slug}" is static; only process, container or function projects can use a user pool.`
			);
		const row = this.#rowByName(principal, input.pool);
		this.#require(principal, 'userPool:update', row);
		if (row.disabled_at !== null)
			throw new ValidationError(`User pool "${row.name}" is disabled; enable it before attaching.`);

		const client = this.ctx.sqlite
			.query<UserPoolClientRow, [string, string, string]>(
				`SELECT * FROM user_pool_clients
				  WHERE pool_id = ? AND (name = ? OR client_id = ?)`
			)
			.get(row.id, input.client, input.client);
		if (!client) throw new NotFoundError('User pool client');
		if (client.public === 1 || !client.client_secret_sealed)
			throw new ValidationError(
				`Client "${client.name}" is public; an attachment needs a confidential client with a secret.`
			);

		const envPrefix = input.envPrefix ?? userPoolDefaultEnvPrefix(row.name);
		const current = this.#attachmentRows(project.id);
		if (current.some((item) => item.pool_id === row.id))
			throw new ConflictError(`User pool "${row.name}" is already attached to "${project.slug}".`);
		if (current.some((item) => item.env_prefix === envPrefix))
			throw new ConflictError(
				`"${project.slug}" already uses the env prefix ${envPrefix}. Pick another, e.g. ${envPrefix}_2.`
			);

		const id = newId('upa_');
		const now = this.ctx.now();
		this.ctx.sqlite.run(
			`INSERT INTO user_pool_attachments
			   (id, org_id, pool_id, client_row_id, project_id, env_prefix, created_by, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[id, principal.orgId, row.id, client.id, project.id, envPrefix, principal.userId, now]
		);
		this.ctx.audit.record({
			principal,
			action: 'user_pool.attach',
			resource: 'user_pool',
			resourceId: row.id,
			args: {
				pool: row.name,
				project: project.slug,
				envPrefix,
				clientId: client.client_id
			},
			result: 'ok'
		});
		this.ctx.projects.bump(principal.orgId);
		return {
			attachment: attachmentView(this.#attachmentById(row.id, project.id)!)
		};
	}

	/** Detach one pool from a project. The pool, its users and its key are untouched. */
	detach(principal: Principal, project: ProjectRow, poolName: string): void {
		this.ctx.iam.require(principal, 'project:update', { type: 'project', id: project.id });
		const row = this.#rowByName(principal, poolName);
		this.#require(principal, 'userPool:update', row);
		const result = this.ctx.sqlite.run(
			'DELETE FROM user_pool_attachments WHERE pool_id = ? AND project_id = ?',
			[row.id, project.id]
		);
		if (result.changes === 0)
			throw new NotFoundError(`Attachment of "${poolName}" to "${project.slug}"`);
		this.ctx.audit.record({
			principal,
			action: 'user_pool.detach',
			resource: 'user_pool',
			resourceId: row.id,
			args: { pool: row.name, project: project.slug },
			result: 'ok'
		});
		this.ctx.projects.bump(principal.orgId);
	}

	/**
	 * Activation env for every pool attached to one project. The client secret is opened here, at
	 * delivery time, exactly like a database password; it is never stored in the workload spec.
	 */
	consumerEnv(projectId: string): Record<string, string> {
		const env: Record<string, string> = {};
		for (const row of this.#attachmentRows(projectId)) {
			const secret = row.client_secret_sealed
				? this.ctx.secrets.open(row.org_id, row.client_secret_sealed)
				: null;
			for (const name of userPoolEnvNames(row.env_prefix)) {
				const suffix = name.slice(row.env_prefix.length + 1);
				if (suffix === 'ISSUER') env[name] = row.issuer;
				else if (suffix === 'CLIENT_ID') env[name] = row.client_id;
				else if (secret !== null) env[name] = secret;
			}
		}
		return env;
	}

	/**
	 * Stable fingerprint of a project's pool attachments, folded into its activation version so
	 * attach, detach or a rotated client secret restarts the app. It hashes the sealed value, never
	 * the secret itself, like the database attachment version.
	 */
	consumerVersion(projectId: string): string {
		const items = this.#attachmentRows(projectId).map((row) => ({
			poolId: row.pool_id,
			prefix: row.env_prefix,
			clientId: row.client_id,
			secret: row.client_secret_sealed ? sha256Hex(row.client_secret_sealed) : null
		}));
		return items.length === 0 ? '' : sha256Hex(JSON.stringify({ userPools: items }));
	}

	/** The project's only attached pool, or null when none or several are attached. */
	soleAttachedPool(projectId: string): UserPoolAttachmentView | null {
		const rows = this.#attachmentRows(projectId);
		return rows.length === 1 ? attachmentView(rows[0]!) : null;
	}

	/**
	 * The `env.AUTH` runtime binding for a function project (IAM.md I28). With no `pool`, the
	 * project's only attached pool is used; several attachments require the manifest to name one.
	 */
	async authBindingForProject(projectId: string, pool?: string): Promise<FunctionRuntimeBinding> {
		const rows = this.#attachmentRows(projectId);
		const row = pool
			? rows.find((item) => item.pool_name === pool)
			: rows.length === 1
				? rows[0]
				: null;
		if (!row) {
			if (pool)
				throw new ValidationError(`User pool "${pool}" is not attached to this project.`);
			if (rows.length === 0)
				throw new ValidationError('Attach a user pool to this project before using an AUTH binding.');
			throw new ValidationError(
				`This project has several user pools attached (${rows.map((item) => item.pool_name).join(', ')}); name one in the AUTH binding.`
			);
		}
		const keys = await this.jwks(row.pool_id);
		return {
			name: USER_POOL_AUTH_BINDING,
			type: 'auth',
			poolId: row.pool_id,
			issuer: row.issuer,
			jwks: keys.keys
		};
	}

	/**
	 * Verify a pool access token against the pool's JWKS and return its user, or null. This is the
	 * same decision the function binding's `verify(request)` makes on the node; exposed here for
	 * tests, the body of a future REST guard and server-rendered checks.
	 */
	async verifyAccessToken(poolId: string, token: string): Promise<UserPoolUserView | null> {
		return this.ctx.userPoolEngine.verifyAccessToken(poolId, token);
	}

	// ---------------------------------------------------------------- public OIDC metadata

	/**
	 * OpenID Connect Discovery for a pool. Public and unauthenticated by design (a client must be
	 * able to read it before a user exists). A disabled pool is deliberately absent, so no client
	 * is told that a switched-off issuer will answer.
	 */
	async discovery(poolId: string): Promise<UserPoolOidcDiscovery> {
		const row = this.#publicRow(poolId);
		await this.#ensurePoolKey(row);
		const issuer = row.issuer;
		return {
			issuer,
			authorization_endpoint: `${issuer}/oauth2/authorize`,
			token_endpoint: `${issuer}/oauth2/token`,
			userinfo_endpoint: `${issuer}/oauth2/userinfo`,
			jwks_uri: `${issuer}/.well-known/jwks.json`,
			end_session_endpoint: `${issuer}/oauth2/logout`,
			response_types_supported: ['code'],
			grant_types_supported: ['authorization_code'],
			subject_types_supported: ['public'],
			id_token_signing_alg_values_supported: ['ES256'],
			scopes_supported: ['openid', 'profile', 'email'],
			token_endpoint_auth_methods_supported: [
				'client_secret_basic',
				'client_secret_post',
				'none'
			],
			code_challenge_methods_supported: ['S256'],
			claims_supported: ['iss', 'sub', 'aud', 'exp', 'iat', 'name', 'email', 'email_verified', 'groups']
		};
	}

	/** The pool's public JWKS: the active and next `pool:<id>` keys, plus retired keys still in their window. */
	async jwks(poolId: string): Promise<UserPoolJwks> {
		const row = this.#publicRow(poolId);
		await this.#ensurePoolKey(row);
		return { keys: this.ctx.signingKeys.jwks(userPoolSigningPurpose(row.id)) };
	}

	// ---------------------------------------------------------------- internals

	/** Invite-only is always verified; an open pool opts in through its setting. */
	#requireEmailVerification(row: UserPoolRow): boolean {
		if (row.signup_mode === 'invite') return true;
		return (
			this.ctx.sqlite
				.query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?')
				.get(userPoolRequireEmailVerificationKey(row.id))?.value === '1'
		);
	}

	#setRequireEmailVerification(poolId: string, value: boolean): void {
		const key = userPoolRequireEmailVerificationKey(poolId);
		if (!value) {
			this.ctx.sqlite.run('DELETE FROM settings WHERE key = ?', [key]);
			return;
		}
		this.ctx.sqlite.run(
			`INSERT INTO settings (key, value, updated_at) VALUES (?, '1', ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
			[key, this.ctx.now()]
		);
	}

	#mfaRequired(row: UserPoolRow): boolean {
		return (
			this.ctx.sqlite
				.query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?')
				.get(userPoolMfaRequiredKey(row.id))?.value === '1'
		);
	}

	#setMfaRequired(poolId: string, value: boolean): void {
		const key = userPoolMfaRequiredKey(poolId);
		if (!value) {
			this.ctx.sqlite.run('DELETE FROM settings WHERE key = ?', [key]);
			return;
		}
		this.ctx.sqlite.run(
			`INSERT INTO settings (key, value, updated_at) VALUES (?, '1', ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
			[key, this.ctx.now()]
		);
	}

	#require(principal: Principal, permission: Permission, pool: UserPoolRow): void {
		this.ctx.iam.require(principal, permission, { type: 'userPool', id: pool.id });
	}

	#rows(orgId: string): UserPoolRow[] {
		return this.ctx.sqlite
			.query<UserPoolRow, [string]>(
				'SELECT * FROM user_pools WHERE org_id = ? ORDER BY name COLLATE NOCASE'
			)
			.all(orgId);
	}

	#row(principal: Principal, id: string): UserPoolRow {
		const row = this.ctx.sqlite
			.query<UserPoolRow, [string, string]>(
				'SELECT * FROM user_pools WHERE id = ? AND org_id = ?'
			)
			.get(id, principal.orgId);
		if (!row) throw new NotFoundError('User pool');
		return row;
	}

	#rowById(id: string): UserPoolRow {
		const row = this.ctx.sqlite
			.query<UserPoolRow, [string]>('SELECT * FROM user_pools WHERE id = ?')
			.get(id);
		if (!row) throw new NotFoundError('User pool');
		return row;
	}

	#rowByName(principal: Principal, name: string): UserPoolRow {
		const row = this.ctx.sqlite
			.query<UserPoolRow, [string, string]>(
				'SELECT * FROM user_pools WHERE name = ? AND org_id = ?'
			)
			.get(name.trim().toLowerCase(), principal.orgId);
		if (!row) throw new NotFoundError('User pool');
		return row;
	}

	#attachmentRows(projectId: string): UserPoolAttachmentRow[] {
		return this.ctx.sqlite
			.query<UserPoolAttachmentRow, [string]>(`${ATTACHMENT_SELECT} WHERE a.project_id = ? ORDER BY a.created_at, a.env_prefix`)
			.all(projectId);
	}

	#attachmentById(poolId: string, projectId: string): UserPoolAttachmentRow | null {
		return (
			this.ctx.sqlite
				.query<UserPoolAttachmentRow, [string, string]>(
					`${ATTACHMENT_SELECT} WHERE a.pool_id = ? AND a.project_id = ?`
				)
				.get(poolId, projectId) ?? null
		);
	}

	/** Attachments of one pool, used by delete to refuse while something still consumes it. */
	attachmentsOf(poolId: string): UserPoolAttachmentView[] {
		return this.ctx.sqlite
			.query<UserPoolAttachmentRow, [string]>(`${ATTACHMENT_SELECT} WHERE a.pool_id = ? ORDER BY a.created_at`)
			.all(poolId)
			.map(attachmentView);
	}

	/** Public reads resolve by id alone, but a disabled pool stops answering discovery. */
	#publicRow(id: string): UserPoolRow {
		const row = this.#rowById(id);
		if (row.disabled_at !== null) throw new NotFoundError('User pool');
		return row;
	}

	#clients(poolId: string): UserPoolClientRow[] {
		return this.ctx.sqlite
			.query<UserPoolClientRow, [string]>(
				'SELECT * FROM user_pool_clients WHERE pool_id = ? ORDER BY name COLLATE NOCASE'
			)
			.all(poolId);
	}

	#clientById(poolId: string, id: string): UserPoolClientRow {
		const row = this.ctx.sqlite
			.query<UserPoolClientRow, [string, string]>(
				'SELECT * FROM user_pool_clients WHERE id = ? AND pool_id = ?'
			)
			.get(id, poolId);
		if (!row) throw new NotFoundError('User pool client');
		return row;
	}

	/** Create or repair the pool's ring entry and keep `signing_key_id` in step with rotation. */
	async #ensurePoolKey(row: UserPoolRow): Promise<void> {
		const key = await this.ctx.signingKeys.active(userPoolSigningPurpose(row.id));
		if (row.signing_key_id !== key.kid) {
			this.ctx.sqlite.run('UPDATE user_pools SET signing_key_id = ? WHERE id = ?', [
				key.kid,
				row.id
			]);
			row.signing_key_id = key.kid;
		}
	}

	#view(row: UserPoolRow): UserPoolView {
		return {
			id: row.id,
			orgId: row.org_id,
			name: row.name,
			description: row.description,
			engine: row.engine as UserPoolEngineId,
			issuer: row.issuer,
			signingKeyId: row.signing_key_id,
			signupMode: row.signup_mode as UserPoolSignupMode,
			requireEmailVerification: this.#requireEmailVerification(row),
			mfaRequired: this.#mfaRequired(row),
			theme: parseTheme(row.theme_json),
			disabled: row.disabled_at !== null,
			disabledAt: row.disabled_at,
			createdBy: row.created_by,
			createdAt: row.created_at,
			updatedAt: row.updated_at
		};
	}
}

function parseTheme(json: string): UserPoolTheme {
	const value = parseJson<unknown>(json, {});
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as UserPoolTheme)
		: {};
}

const ATTACHMENT_SELECT = `SELECT a.*, p.name AS pool_name, p.issuer, c.name AS client_name,
	   c.client_id, c.client_secret_sealed, c.public AS client_public, pr.slug AS project_slug
  FROM user_pool_attachments a
  JOIN user_pools p ON p.id = a.pool_id
  JOIN user_pool_clients c ON c.id = a.client_row_id
  JOIN projects pr ON pr.id = a.project_id`;

function attachmentView(row: UserPoolAttachmentRow): UserPoolAttachmentView {
	return {
		id: row.id,
		orgId: row.org_id,
		poolId: row.pool_id,
		poolName: row.pool_name,
		issuer: row.issuer,
		clientId: row.client_id,
		clientName: row.client_name,
		projectId: row.project_id,
		projectSlug: row.project_slug,
		envPrefix: row.env_prefix,
		envNames: userPoolEnvNames(row.env_prefix),
		createdAt: new Date(row.created_at).toISOString()
	};
}

function clientView(row: UserPoolClientRow): UserPoolClientView {
	const uris = parseJson<unknown>(row.redirect_uris_json, []);
	return {
		id: row.id,
		poolId: row.pool_id,
		name: row.name,
		clientId: row.client_id,
		redirectUris: Array.isArray(uris)
			? uris.filter((uri): uri is string => typeof uri === 'string')
			: [],
		public: row.public === 1,
		createdAt: row.created_at
	};
}
