/**
 * Managed user pools (IAM.md I26–I29, §11.2).
 *
 * A pool is an org resource like a database, but its purpose is authentication for one deployed
 * app's own end users. This slice owns the pool row, its OIDC clients, and the public discovery
 * and JWKS documents. It deliberately does **not** implement users, passwords, sessions, hosted
 * sign-in pages, MFA or email: those belong to the native `yoal-identity` engine (I27), which
 * runs as its own process with its own SQLite file per pool. The engine seam is recorded below so
 * the control plane never pretends it is already hosting users.
 *
 * Signing is the one piece that exists today: each pool gets a key in the platform ring with
 * purpose `pool:<id>` (IAM.md I15, §7.3). Discovery and JWKS are public, unauthenticated reads;
 * every write is a normal IAM permission check on the pool resource.
 */
import {
	USER_POOL_AUTH_BINDING,
	USER_POOL_EXPORT_SCHEMA,
	USER_POOL_EXPORT_VERSION,
	userPoolAttachSchema,
	userPoolClientCreateSchema,
	userPoolCreateSchema,
	userPoolDefaultEnvPrefix,
	userPoolEnvNames,
	userPoolOAuthProviders,
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
	type UserPoolExport,
	type UserPoolExportClient,
	type UserPoolExportGroup,
	type UserPoolExportMetadata,
	type UserPoolExportOAuthProvider,
	type UserPoolGroupMemberView,
	type UserPoolGroupView,
	type UserPoolImportFormat,
	type UserPoolImportFormatId,
	type UserPoolImportReport,
	type UserPoolImportRequest,
	type UserPoolJwks,
	type UserPoolOAuthProviderConfig,
	type UserPoolOAuthProviderView,
	type UserPoolOidcDiscovery,
	type UserPoolPasswordAlgorithm,
	type UserPoolSignupMode,
	type UserPoolTheme,
	type UserPoolUpdate,
	type UserPoolView
} from '@yoal/contracts';
import type { CoreContext } from './context.ts';
import type { ProjectRow } from './projects.ts';
import type {
	UserPoolInviteCreated,
	UserPoolInviteView,
	UserPoolSessionView,
	UserPoolUserView
} from './user-pool-engine.ts';
import {
	scryptHashFromParts,
	userPoolPasswordAlgorithm
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

/** The per-pool "check new passwords against Have I Been Pwned" switch. */
export function userPoolBreachCheckKey(poolId: string): string {
	return `user_pool.${poolId}.breach_check`;
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
 * `implemented` is false until `yoal-agent identity` exists, so the dashboard can say so honestly.
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
	'yoal-identity': {
		id: 'yoal-identity',
		label: 'Yoal Identity',
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

/** A support-impersonation session: the user, the session claim and the one-time token. */
export interface UserPoolImpersonationView {
	user: UserPoolUserView;
	session: UserPoolSessionView & { impersonatedBy: string };
	/** Raw opaque pool-session token; shown once, never stored in the clear. */
	token: string;
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

	/**
	 * Start a short-lived support-impersonation session for one pool user (IAM.md I29).
	 *
	 * An impersonated session is a normal pool session with an `impersonatedBy` claim, so it is
	 * accepted only by the pool's OAuth/hosted surfaces, never by Yoal's platform admin API (which
	 * takes a platform session, key or STS token). The app still sees the user's full identity: the
	 * remaining risk is that an app which ignores `impersonated_by` cannot tell support apart. The
	 * session is capped at one hour and every start/end is audited with the admin as `actingFor`.
	 */
	impersonateUser(
		principal: Principal,
		poolId: string,
		userId: string,
		options: { ttlSeconds?: number } = {}
	): UserPoolImpersonationView {
		const row = this.#row(principal, poolId);
		this.#require(principal, 'userPool:impersonate-user', row);
		const result = this.ctx.userPoolEngine.impersonate(
			row.id,
			userId,
			principal.userId,
			options
		);
		this.ctx.audit.record({
			principal,
			action: 'user_pool.user.impersonate',
			resource: 'user_pool_user',
			resourceId: result.user.id,
			args: {
				poolId: row.id,
				pool: row.name,
				email: result.user.email,
				userId: result.user.id,
				sessionId: result.session.id,
				expiresAt: result.session.expiresAt,
				actingFor: principal.userId,
			},
			result: 'ok',
		});
		return {
			user: result.user,
			session: result.session,
			token: result.token,
		};
	}

	/**
	 * End support impersonation for one user. Only sessions started by `impersonateUser` are
	 * revoked; the user's own normal sessions stay signed in.
	 */
	endImpersonation(principal: Principal, poolId: string, userId: string): { revoked: number } {
		const row = this.#row(principal, poolId);
		this.#require(principal, 'userPool:impersonate-user', row);
		const user = this.ctx.userPoolEngine.user(row.id, userId);
		const revoked = this.ctx.userPoolEngine.endImpersonation(row.id, userId);
		this.ctx.audit.record({
			principal,
			action: 'user_pool.user.impersonation.end',
			resource: 'user_pool_user',
			resourceId: user.id,
			args: {
				poolId: row.id,
				pool: row.name,
				email: user.email,
				userId: user.id,
				revoked,
				actingFor: principal.userId,
			},
			result: 'ok',
		});
		return { revoked };
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

	// ---------------------------------------------------------------- social login

	/** Provider configuration for Settings; never includes a client secret. */
	listOAuthProviders(principal: Principal, poolId: string): UserPoolOAuthProviderView[] {
		const row = this.#row(principal, poolId);
		this.#require(principal, 'userPool:credentials', row);
		return this.ctx.userPoolEngine.listOAuthProviders(row.id);
	}

	/** Create or update one provider. The secret is write-only and sealed by the engine. */
	setOAuthProvider(
		principal: Principal,
		poolId: string,
		provider: string,
		raw: UserPoolOAuthProviderConfig
	): UserPoolOAuthProviderView {
		const row = this.#row(principal, poolId);
		this.#require(principal, 'userPool:credentials', row);
		const view = this.ctx.userPoolEngine.setOAuthProvider(row.id, provider, raw);
		// Metadata only: the client secret must never reach an audit row.
		this.ctx.audit.record({
			principal,
			action: 'user_pool.oauth_provider.update',
			resource: 'user_pool',
			resourceId: row.id,
			args: {
				poolId: row.id,
				pool: row.name,
				provider: view.provider,
				clientId: view.clientId,
				scopes: view.scopes,
				enabled: view.enabled
			},
			result: 'ok'
		});
		return view;
	}

	deleteOAuthProvider(principal: Principal, poolId: string, provider: string): void {
		const row = this.#row(principal, poolId);
		this.#require(principal, 'userPool:credentials', row);
		if (!this.ctx.userPoolEngine.deleteOAuthProvider(row.id, provider))
			throw new NotFoundError('User pool social provider');
		this.ctx.audit.record({
			principal,
			action: 'user_pool.oauth_provider.delete',
			resource: 'user_pool',
			resourceId: row.id,
			args: { poolId: row.id, pool: row.name, provider },
			result: 'ok'
		});
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

	// ---------------------------------------------------------------- export and import

	/**
	 * A versioned JSON snapshot of one pool for backup or migration. Password hashes are included
	 * because a migrated account must keep its password; client and provider secrets are not, so a
	 * reader of the file cannot impersonate a client. Callers need `userPool:manage-users`.
	 */
	exportPool(principal: Principal, poolId: string): UserPoolExport {
		const row = this.#row(principal, poolId);
		this.#require(principal, 'userPool:manage-users', row);
		const users = this.ctx.userPoolEngine.listUsersForExport(row.id);
		const groups: UserPoolExportGroup[] = this.ctx.userPoolEngine
			.listGroups(row.id)
			.map((group) => ({
				id: group.id,
				name: group.name,
				createdAt: group.createdAt,
				members: this.ctx.userPoolEngine
					.listGroupMembers(row.id, group.id)
					.map((member) => member.email)
			}));
		const clients: UserPoolExportClient[] = this.#clients(row.id).map((client) => ({
			id: client.id,
			name: client.name,
			clientId: client.client_id,
			redirectUris: parseStringArray(client.redirect_uris_json),
			public: client.public === 1,
			createdAt: client.created_at,
			clientSecret: null,
			secretHandling: 'regenerated-on-import'
		}));
		const oauthProviders: UserPoolExportOAuthProvider[] = this.ctx.userPoolEngine
			.listOAuthProviders(row.id)
			.filter((provider) => provider.configured)
			.map((provider) => ({
				provider: provider.provider,
				clientId: provider.clientId,
				scopes: [...provider.scopes],
				enabled: provider.enabled,
				createdAt: provider.createdAt ?? this.ctx.now(),
				secretOmitted: true
			}));
		const metadata: UserPoolExportMetadata = {
			id: row.id,
			name: row.name,
			description: row.description,
			engine: row.engine as UserPoolEngineId,
			signupMode: row.signup_mode as UserPoolSignupMode,
			requireEmailVerification: this.#requireEmailVerification(row),
			mfaRequired: this.#mfaRequired(row),
			breachCheckEnabled: this.#breachCheckEnabled(row),
			theme: parseTheme(row.theme_json)
		};
		this.ctx.audit.record({
			principal,
			action: 'user_pool.export',
			resource: 'user_pool',
			resourceId: row.id,
			args: { poolId: row.id, pool: row.name, users: users.length },
			result: 'ok'
		});
		return {
			schema: USER_POOL_EXPORT_SCHEMA,
			version: USER_POOL_EXPORT_VERSION,
			exportedAt: new Date(this.ctx.now()).toISOString(),
			pool: metadata,
			users,
			groups,
			clients,
			oauthProviders
		};
	}

	/**
	 * Import Auth0, Cognito, Firebase or a Yoal pool export. `dryRun` never writes and returns the
	 * same counts as an apply. Duplicate addresses are skipped, never overwritten. A hash this
	 * engine cannot verify forces a password reset instead of silently storing a dead password.
	 */
	async importPool(
		principal: Principal,
		poolId: string,
		request: UserPoolImportRequest
	): Promise<UserPoolImportReport> {
		const row = this.#row(principal, poolId);
		this.#require(principal, 'userPool:manage-users', row);
		const dryRun = request.dryRun === true;
		const normalized = normalizePoolImport(request.data, request.format ?? 'auto');
		const report: UserPoolImportReport = {
			format: normalized.format,
			dryRun,
			users: {
				total: normalized.users.length,
				create: 0,
				skip: 0,
				invalid: 0,
				mustResetPassword: 0,
				unsupportedHashes: []
			},
			groups: { total: normalized.groups.length, create: 0, skip: 0 },
			clients: { total: normalized.clients.length, create: 0, skip: 0 },
			oauthProviders: {
				total: normalized.oauthProviders.length,
				create: 0,
				skip: 0,
				needsSecret: 0
			},
			outcomes: [],
			clientSecrets: []
		};

		const existingEmails = new Set(this.ctx.userPoolEngine.listUsers(row.id).map((user) => user.email));
		const seen = new Set<string>();
		const creates: NormalizedImportUser[] = [];
		for (const user of normalized.users) {
			if (user.invalidReason) {
				report.users.invalid += 1;
				report.outcomes.push({
					email: user.email,
					action: 'invalid',
					reason: user.invalidReason,
					passwordAlgorithm: user.passwordAlgorithm,
					mustResetPassword: user.mustResetPassword
				});
				continue;
			}
			if (existingEmails.has(user.email) || seen.has(user.email)) {
				report.users.skip += 1;
				report.outcomes.push({
					email: user.email,
					action: 'skip',
					reason: existingEmails.has(user.email)
						? 'An account with that email already exists.'
						: 'That email appears more than once in the file.',
					passwordAlgorithm: user.passwordAlgorithm,
					mustResetPassword: user.mustResetPassword
				});
				continue;
			}
			seen.add(user.email);
			creates.push(user);
			if (user.mustResetPassword) report.users.mustResetPassword += 1;
			if (user.unsupportedHash) report.users.unsupportedHashes.push(user.unsupportedHash);
			report.outcomes.push({
				email: user.email,
				action: 'create',
				...(user.mustResetPassword ? { reason: user.resetReason } : {}),
				passwordAlgorithm: user.passwordAlgorithm,
				mustResetPassword: user.mustResetPassword
			});
		}
		report.users.create = creates.length;

		// Dry run stops before any write. Counts above are the whole answer.
		if (dryRun) {
			report.groups.create = normalized.groups.filter(
				(group) => !this.#groupNameExists(row.id, group.name)
			).length;
			report.groups.skip = report.groups.total - report.groups.create;
			report.clients.create = normalized.clients.filter(
				(client) => !this.#clientNameExists(row.id, client.name)
			).length;
			report.clients.skip = report.clients.total - report.clients.create;
			const providers = new Set(
				this.ctx.userPoolEngine.listOAuthProviders(row.id).filter((p) => p.configured).map((p) => p.provider)
			);
			report.oauthProviders.create = normalized.oauthProviders.filter(
				(provider) => !providers.has(provider.provider)
			).length;
			report.oauthProviders.skip =
				report.oauthProviders.total - report.oauthProviders.create;
			report.oauthProviders.needsSecret = report.oauthProviders.create;
			return report;
		}

		// A forced reset needs a valid hash that no password can match; hash one random value once
		// and share it across every reset account in this import.
		const resetHash = creates.some((user) => user.mustResetPassword)
			? await Bun.password.hash(randomToken(32), { algorithm: 'argon2id' })
			: null;
		for (const user of creates) {
			const passwordHash = user.mustResetPassword ? resetHash! : user.passwordHash!;
			try {
				this.ctx.userPoolEngine.importUserRecord(row.id, {
					email: user.email,
					name: user.name,
					emailVerified: user.emailVerified,
					disabled: user.disabled,
					passwordHash,
					metadata: {
						...user.metadata,
						...(user.mustResetPassword ? { mustResetPassword: true } : {})
					}
				});
			} catch (cause) {
				// A concurrent import won the unique index. Count it as skipped, not a hard failure.
				if (cause instanceof ConflictError) {
					report.users.create -= 1;
					report.users.skip += 1;
					const outcome = report.outcomes.find(
						(item) => item.email === user.email && item.action === 'create'
					);
					if (outcome) {
						outcome.action = 'skip';
						outcome.reason = 'An account with that email already exists.';
					}
					continue;
				}
				throw cause;
			}
		}
		if (report.users.create === 0) report.users.mustResetPassword = 0;

		// Groups are created only when the name is free; membership is mapped by email across both
		// the existing users and the rows this import just created.
		const emailToId = new Map(
			this.ctx.userPoolEngine.listUsers(row.id).map((user) => [user.email, user.id])
		);
		for (const group of normalized.groups) {
			if (this.#groupNameExists(row.id, group.name)) {
				report.groups.skip += 1;
				continue;
			}
			const created = this.ctx.userPoolEngine.createGroup(row.id, group.name);
			report.groups.create += 1;
			for (const email of group.members) {
				const userId = emailToId.get(email);
				if (userId) this.ctx.userPoolEngine.addGroupMember(row.id, created.id, userId);
			}
		}

		// A fresh secret replaces every omitted client secret and is returned exactly once.
		for (const client of normalized.clients) {
			if (this.#clientNameExists(row.id, client.name)) {
				report.clients.skip += 1;
				continue;
			}
			const created = this.#insertImportedClient(row, client);
			report.clients.create += 1;
			if (created.clientSecret)
				report.clientSecrets.push({
					name: client.name,
					clientId: created.clientId,
					clientSecret: created.clientSecret
				});
		}

		// Providers are imported disabled with an unusable sealed placeholder: the real secret was
		// deliberately left out of the export and must be pasted into Settings before enabling.
		const configuredProviders = new Set(
			this.ctx.userPoolEngine.listOAuthProviders(row.id).filter((p) => p.configured).map((p) => p.provider)
		);
		for (const provider of normalized.oauthProviders) {
			if (configuredProviders.has(provider.provider)) {
				report.oauthProviders.skip += 1;
				continue;
			}
			this.ctx.userPoolEngine.setOAuthProvider(row.id, provider.provider, {
				clientId: provider.clientId,
				clientSecret: randomToken(32),
				scopes: provider.scopes,
				enabled: false
			});
			report.oauthProviders.create += 1;
			report.oauthProviders.needsSecret += 1;
		}

		this.ctx.audit.record({
			principal,
			action: 'user_pool.import',
			resource: 'user_pool',
			resourceId: row.id,
			args: {
				poolId: row.id,
				pool: row.name,
				format: report.format,
				users: report.users.create,
				skipped: report.users.skip,
				invalid: report.users.invalid,
				forcedReset: report.users.mustResetPassword
			},
			result: 'ok'
		});
		return report;
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
		if (input.breachCheckEnabled) this.#setBreachCheckEnabled(id, true);
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
				breachCheckEnabled: input.breachCheckEnabled === true,
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
		const breachCheckEnabled = patch.breachCheckEnabled ?? this.#breachCheckEnabled(row);
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
			breachCheckEnabled === this.#breachCheckEnabled(row) &&
			disabledAt === row.disabled_at &&
			JSON.stringify(theme) === JSON.stringify(parseTheme(row.theme_json));
		if (unchanged) return this.#view(row);

		if (patch.requireEmailVerification !== undefined)
			this.#setRequireEmailVerification(row.id, patch.requireEmailVerification);
		if (patch.mfaRequired !== undefined) this.#setMfaRequired(row.id, patch.mfaRequired);
		if (patch.breachCheckEnabled !== undefined)
			this.#setBreachCheckEnabled(row.id, patch.breachCheckEnabled);
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
				breachCheckEnabled,
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

	#breachCheckEnabled(row: UserPoolRow): boolean {
		return (
			this.ctx.sqlite
				.query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?')
				.get(userPoolBreachCheckKey(row.id))?.value === '1'
		);
	}

	#setBreachCheckEnabled(poolId: string, value: boolean): void {
		const key = userPoolBreachCheckKey(poolId);
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

	#groupNameExists(poolId: string, name: string): boolean {
		return Boolean(
			this.ctx.sqlite
				.query<{ id: string }, [string, string]>(
					'SELECT id FROM user_pool_groups WHERE pool_id = ? AND name = ? COLLATE NOCASE'
				)
				.get(poolId, name)
		);
	}

	#clientNameExists(poolId: string, name: string): boolean {
		return Boolean(
			this.ctx.sqlite
				.query<{ id: string }, [string, string]>(
					'SELECT id FROM user_pool_clients WHERE pool_id = ? AND name = ?'
				)
				.get(poolId, name)
		);
	}

	/** Create an imported client without requiring `userPool:credentials`; the import is audited. */
	#insertImportedClient(
		pool: UserPoolRow,
		input: NormalizedImportClient
	): { clientId: string; clientSecret: string | null } {
		const id = newId('upcc_');
		const clientId = newId('upc_');
		const clientSecret = input.public ? null : randomToken(32);
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
				this.ctx.now()
			]
		);
		return { clientId, clientSecret };
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
			breachCheckEnabled: this.#breachCheckEnabled(row),
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

// ---------------------------------------------------------------- import normalisation

interface NormalizedImportUser {
	email: string;
	name: string;
	emailVerified: boolean;
	disabled: boolean;
	passwordHash: string | null;
	passwordAlgorithm: UserPoolPasswordAlgorithm;
	mustResetPassword: boolean;
	resetReason?: string;
	unsupportedHash?: { email: string; algorithm: string; reason: string };
	invalidReason?: string;
	metadata: Record<string, unknown>;
}

interface NormalizedImportGroup {
	name: string;
	members: string[];
}

interface NormalizedImportClient {
	name: string;
	redirectUris: string[];
	public: boolean;
}

interface NormalizedImportOAuthProvider {
	provider: UserPoolExportOAuthProvider['provider'];
	clientId: string;
	scopes: string[];
	enabled: boolean;
}

interface NormalizedPoolImport {
	format: UserPoolImportFormat;
	users: NormalizedImportUser[];
	groups: NormalizedImportGroup[];
	clients: NormalizedImportClient[];
	oauthProviders: NormalizedImportOAuthProvider[];
}

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function text(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
	return typeof value === 'boolean' ? value : undefined;
}

function number(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseStringArray(raw: string): string[] {
	const value = parseJson<unknown>(raw, []);
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function importEmail(raw: string | undefined): { email: string } | { invalid: string } {
	const email = (raw ?? '').trim().toLowerCase();
	if (!email) return { invalid: 'The row has no email address.' };
	if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
		return { invalid: 'That email address is not valid.' };
	return { email };
}

/** Detect the document family. An explicit format always wins. */
function detectPoolImportFormat(data: unknown): UserPoolImportFormat {
	let value = data;
	if (typeof value === 'string') {
		try {
			value = JSON.parse(value) as unknown;
		} catch {
			return 'cognito';
		}
	}
	if (Array.isArray(value)) {
		const first = record(value[0]);
		if (first?.localId) return 'firebase';
		if (first?.user_id || first?.custom_password_hash) return 'auth0';
		if (first?.passwordAlgorithm || first?.passwordHash) return 'yoal';
		return 'auth0';
	}
	const root = record(value);
	if (!root) throw new ValidationError('The import file is not a JSON object or a CSV export.');
	if (root.schema === USER_POOL_EXPORT_SCHEMA) return 'yoal';
	if (Array.isArray(root.Users)) return 'cognito';
	if (Array.isArray(root.users)) {
		const first = record(root.users[0]);
		if (root.pool && root.version) return 'yoal';
		if (first?.localId) return 'firebase';
		if (first?.user_id || first?.custom_password_hash) return 'auth0';
		if (first?.passwordAlgorithm) return 'yoal';
		return 'yoal';
	}
	throw new ValidationError('Could not recognise that user export. Use Auth0, Cognito, Firebase or a Yoal pool export.');
}

/** Normalise every supported document into the same rows before the dry run or apply. */
function normalizePoolImport(
	raw: unknown,
	requested: UserPoolImportFormatId
): NormalizedPoolImport {
	if (requested !== 'auto') {
		const forced = normalizeWithFormat(raw, requested);
		return forced;
	}
	const format = detectPoolImportFormat(raw);
	return normalizeWithFormat(raw, format);
}

function normalizeWithFormat(raw: unknown, format: UserPoolImportFormat): NormalizedPoolImport {
	if (typeof raw === 'string') {
		if (format === 'cognito') {
			const rows = parseCsv(raw);
			return {
				format,
				users: rows.map(cognitoCsvUser),
				groups: [],
				clients: [],
				oauthProviders: []
			};
		}
		try {
			return normalizeWithFormat(JSON.parse(raw) as unknown, format);
		} catch (cause) {
			if (cause instanceof ValidationError) throw cause;
			throw new ValidationError('The import file is not valid JSON.');
		}
	}
	if (format === 'yoal') return normalizeYoalImport(raw);
	if (format === 'auth0') return normalizeAuth0Import(raw);
	if (format === 'cognito') return normalizeCognitoImport(raw);
	return normalizeFirebaseImport(raw);
}

function normalizeYoalImport(raw: unknown): NormalizedPoolImport {
	const root = record(raw) ?? {};
	if (!Array.isArray(raw) && Object.keys(root).length === 0)
		throw new ValidationError('A Yoal pool export must be a JSON object.');
	if (root.version !== undefined && root.version !== USER_POOL_EXPORT_VERSION)
		throw new ValidationError(
			`This pool export is version ${String(root.version)}; this platform imports version ${USER_POOL_EXPORT_VERSION}.`
		);
	const list = Array.isArray(root.users) ? root.users : Array.isArray(raw) ? raw : null;
	if (!list) throw new ValidationError('The Yoal export has no users array.');
	const users = list.map((entry) => {
		const user = record(entry) ?? {};
		const email = importEmail(text(user.email));
		const rawHash = text(user.passwordHash) ?? null;
		const hash = classifyImportedHash(rawHash, text(user.passwordAlgorithm), false);
		const alreadyReset = user.mustResetPassword === true;
		return finishUser({
			email,
			name: text(user.name) ?? '',
			emailVerified: bool(user.emailVerified) ?? false,
			disabled: bool(user.disabled) ?? false,
			hash,
			forceReset: alreadyReset,
			metadata: record(user.metadata) ?? {}
		});
	});
	const groups = (Array.isArray(root.groups) ? root.groups : []).flatMap((entry) => {
		const group = record(entry);
		const name = text(group?.name)?.trim();
		if (!name) return [];
		return [
			{
				name,
				members: Array.isArray(group?.members)
					? group.members.flatMap((member) => {
							if (typeof member === 'string') return [member.trim().toLowerCase()].filter(Boolean);
							const row = record(member);
							const email = text(row?.email)?.trim().toLowerCase();
							return email ? [email] : [];
						})
					: []
			}
		];
	});
	const clients = (Array.isArray(root.clients) ? root.clients : []).flatMap((entry) => {
		const client = record(entry);
		const name = text(client?.name)?.trim();
		if (!name) return [];
		return [
			{
				name,
				redirectUris: Array.isArray(client?.redirectUris)
					? client.redirectUris.filter((uri): uri is string => typeof uri === 'string')
					: [],
				public: bool(client?.public) ?? false
			}
		];
	});
	const oauthProviders = (
		Array.isArray(root.oauthProviders) ? root.oauthProviders : []
	).flatMap((entry) => {
		const provider = record(entry);
		const id = text(provider?.provider);
		if (!id || !(userPoolOAuthProviders as readonly string[]).includes(id)) return [];
		return [
			{
				provider: id as UserPoolExportOAuthProvider['provider'],
				clientId: text(provider?.clientId) ?? '',
				scopes: Array.isArray(provider?.scopes)
					? provider.scopes.filter((scope): scope is string => typeof scope === 'string')
					: [],
				enabled: bool(provider?.enabled) ?? false
			}
		];
	});
	return { format: 'yoal', users, groups, clients, oauthProviders };
}

function normalizeAuth0Import(raw: unknown): NormalizedPoolImport {
	const list = Array.isArray(raw)
		? raw
		: Array.isArray(record(raw)?.users)
			? (record(raw)!.users as unknown[])
			: null;
	if (!list) throw new ValidationError('The Auth0 export has no users array.');
	return {
		format: 'auth0',
		users: list.map((entry) => {
			const user = record(entry) ?? {};
			const email = importEmail(text(user.email));
			const custom = record(user.custom_password_hash);
			const customHash = record(custom?.hash);
			const declared = text(custom?.algorithm);
			const rawHash =
				text(customHash?.value) ??
				text(user.password_hash) ??
				text(user.passwordHash) ??
				null;
			return finishUser({
				email,
				name: text(user.name) ?? text(user.nickname) ?? '',
				emailVerified: bool(user.email_verified) ?? false,
				disabled: bool(user.blocked) ?? false,
				hash: classifyImportedHash(rawHash, declared, false),
				metadata: record(user.user_metadata) ?? {}
			});
		}),
		groups: [],
		clients: [],
		oauthProviders: []
	};
}

function normalizeCognitoImport(raw: unknown): NormalizedPoolImport {
	const root = record(raw);
	const list = Array.isArray(root?.Users) ? (root!.Users as unknown[]) : null;
	if (!list)
		throw new ValidationError('The Cognito export has no Users array. Export users from the user pool as JSON or CSV.');
	return {
		format: 'cognito',
		users: list.map((entry) => {
			const user = record(entry) ?? {};
			const attributes = new Map<string, string>();
			if (Array.isArray(user.Attributes))
				for (const attribute of user.Attributes) {
					const row = record(attribute);
					const name = text(row?.Name);
					const value = text(row?.Value);
					if (name && value !== undefined) attributes.set(name, value);
				}
			const email = importEmail(attributes.get('email') ?? text(user.email) ?? text(user.Username));
			return finishUser({
				email,
				name: attributes.get('name') ?? attributes.get('given_name') ?? '',
				emailVerified: attributes.get('email_verified') === 'true',
				disabled: user.Enabled === false || user.UserStatus === 'ARCHIVED',
				hash: classifyImportedHash(text(user.password_hash) ?? null, undefined, false),
				metadata: { sub: attributes.get('sub') }
			});
		}),
		groups: [],
		clients: [],
		oauthProviders: []
	};
}

function cognitoCsvUser(entry: Record<string, string>): NormalizedImportUser {
	const email = importEmail(entry.email ?? entry['cognito:username'] ?? entry.username);
	return finishUser({
		email,
		name: entry.name ?? entry.given_name ?? '',
		emailVerified: (entry.email_verified ?? '').toLowerCase() === 'true',
		disabled: (entry.enabled ?? '').toLowerCase() === 'false',
		hash: classifyImportedHash(entry.password_hash ?? null, undefined, false),
		metadata: entry.sub ? { sub: entry.sub } : {}
	});
}

function normalizeFirebaseImport(raw: unknown): NormalizedPoolImport {
	const root = record(raw);
	const list = Array.isArray(raw)
		? raw
		: Array.isArray(root?.users)
			? (root!.users as unknown[])
			: null;
	if (!list) throw new ValidationError('The Firebase export has no users array.');
	return {
		format: 'firebase',
		users: list.map((entry) => {
			const user = record(entry) ?? {};
			const email = importEmail(text(user.email));
			const hash = firebaseHash(user);
			return finishUser({
				email,
				name: text(user.displayName) ?? '',
				emailVerified: bool(user.emailVerified) ?? false,
				disabled: bool(user.disabled) ?? false,
				hash,
				forceReset: hash.mustReset,
				resetReason: hash.reason,
				unsupportedHash: hash.unsupported,
				metadata: {}
			});
		}),
		groups: [],
		clients: [],
		oauthProviders: []
	};
}

interface ClassifiedHash {
	hash: string | null;
	algorithm: UserPoolPasswordAlgorithm;
	mustReset: boolean;
	reason?: string;
	unsupported?: { email: string; algorithm: string; reason: string };
}
/** Classify a stored hash. A hash this engine cannot verify becomes a forced reset. */
function classifyImportedHash(
	rawHash: string | null,
	declared: string | undefined,
	forceReset: boolean
): ClassifiedHash {
	if (!rawHash || forceReset)
		return {
			hash: null,
			algorithm: 'none',
			mustReset: true,
			reason: forceReset ? 'The export marks this account for a password reset.' : 'No password hash was exported.'
		};
	const algorithm = userPoolPasswordAlgorithm(rawHash);
	if (algorithm !== 'none')
		return { hash: rawHash, algorithm, mustReset: false };
	const name = (declared ?? 'unknown').trim().toLowerCase();
	return {
		hash: null,
		algorithm: 'none',
		mustReset: true,
		reason: `Unsupported password hash (${name}). The account must set a new password.`
	};
}

function firebaseHash(user: Record<string, unknown>): ClassifiedHash {
	const raw = text(user.passwordHash) ?? null;
	if (!raw) return { hash: null, algorithm: 'none', mustReset: true, reason: 'No password hash was exported.' };
	// A modern Firebase export may carry an encoded hash directly; keep it when we understand it.
	const direct = userPoolPasswordAlgorithm(raw);
	if (direct !== 'none') return { hash: raw, algorithm: direct, mustReset: false };
	const declared = (text(user.hashAlgorithm) ?? '').toUpperCase();
	const salt = text(user.salt);
	const params = record(user.hashParameters);
	if (declared !== 'SCRYPT' || !salt)
		return {
			hash: null,
			algorithm: 'none',
			mustReset: true,
			reason: `Unsupported Firebase hash (${declared || 'unknown'}). The account must set a new password.`,
			unsupported: {
				email: text(user.email) ?? '',
				algorithm: declared || 'unknown',
				reason: 'Firebase hashes are not encoded as a verifiable value.'
			}
		};
	if (params?.base64_signer_key || params?.base64_salt_separator)
		return {
			hash: null,
			algorithm: 'none',
			mustReset: true,
			reason: 'Firebase SCRYPT uses a signer key that cannot be imported. The account must set a new password.',
			unsupported: {
				email: text(user.email) ?? '',
				algorithm: 'SCRYPT',
				reason: 'Firebase signer key is not representable in the portable scrypt hash.'
			}
		};
	const memCost = number(params?.mem_cost);
	const rounds = number(params?.rounds);
	const N =
		rounds !== undefined && (rounds & (rounds - 1)) === 0
			? rounds
			: memCost !== undefined && memCost <= 20
				? 2 ** memCost
				: undefined;
	const wrapped = N
		? scryptHashFromParts(
				{ N, r: number(params?.blockSize), p: number(params?.parallelization) },
				Buffer.from(salt, 'base64'),
				Buffer.from(raw, 'base64')
			)
		: null;
	if (wrapped) return { hash: wrapped, algorithm: 'scrypt', mustReset: false };
	return {
		hash: null,
		algorithm: 'none',
		mustReset: true,
		reason: 'Unsupported Firebase SCRYPT parameters. The account must set a new password.',
		unsupported: {
			email: text(user.email) ?? '',
			algorithm: 'SCRYPT',
			reason: 'The SCRYPT cost or key length is not supported.'
		}
	};
}

function finishUser(input: {
	email: { email: string } | { invalid: string };
	name: string;
	emailVerified: boolean;
	disabled: boolean;
	hash: ClassifiedHash;
	forceReset?: boolean;
	resetReason?: string;
	unsupportedHash?: { email: string; algorithm: string; reason: string };
	metadata: Record<string, unknown>;
}): NormalizedImportUser {
	const address = 'email' in input.email ? input.email.email : '';
	const invalidReason = 'invalid' in input.email ? input.email.invalid : undefined;
	const mustReset = input.hash.mustReset || input.forceReset === true;
	const unsupported = input.unsupportedHash ?? (mustReset && input.hash.algorithm === 'none' && !invalidReason
		? {
				email: address,
				algorithm: 'unknown',
				reason: input.resetReason ?? input.hash.reason ?? 'The password hash is not supported.'
			}
		: undefined);
	return {
		email: address,
		name: input.name.slice(0, 120),
		emailVerified: input.emailVerified,
		disabled: input.disabled,
		passwordHash: input.hash.hash,
		passwordAlgorithm: input.hash.algorithm,
		mustResetPassword: mustReset,
		...(mustReset ? { resetReason: input.resetReason ?? input.hash.reason } : {}),
		...(unsupported ? { unsupportedHash: unsupported } : {}),
		...(invalidReason ? { invalidReason } : {}),
		metadata: input.metadata
	};
}

/** Minimal RFC 4180 CSV reader, enough for a Cognito export with quoted commas. */
function parseCsv(source: string): Array<Record<string, string>> {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = '';
	let quoted = false;
	for (let index = 0; index < source.length; index += 1) {
		const char = source[index]!;
		if (quoted) {
			if (char === '"') {
				if (source[index + 1] === '"') {
					field += '"';
					index += 1;
				} else quoted = false;
			} else field += char;
			continue;
		}
		if (char === '"') {
			quoted = true;
			continue;
		}
		if (char === ',') {
			row.push(field);
			field = '';
			continue;
		}
		if (char === '\n' || char === '\r') {
			if (char === '\r' && source[index + 1] === '\n') index += 1;
			row.push(field);
			if (row.some((value) => value.trim() !== '')) rows.push(row);
			row = [];
			field = '';
			continue;
		}
		field += char;
	}
	if (field !== '' || row.length > 0) {
		row.push(field);
		if (row.some((value) => value.trim() !== '')) rows.push(row);
	}
	if (rows.length < 2) return [];
	const headers = rows[0]!.map((value) => value.trim().toLowerCase());
	return rows.slice(1).map((values) => {
		const entry: Record<string, string> = {};
		for (let index = 0; index < headers.length; index += 1)
			entry[headers[index]!] = (values[index] ?? '').trim();
		return entry;
	});
}
