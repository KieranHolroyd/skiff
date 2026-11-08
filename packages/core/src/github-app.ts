import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { githubInstallations, settings } from '@skiff/db';
import {
	canAdministerPlatform,
	githubAppManifest,
	githubAppManifestStartSchema,
	githubAppManifestUrl,
	githubAppManualSchema,
	missingPermissions,
	parseGithubRepoUrl,
	sameGithubRepo,
	type GithubAppManifestStart,
	type GithubAppManual,
	type GithubAppPermission,
	type GithubAppView,
	type GithubInstallationView,
	type GithubRepositoryLink,
	type GithubRepositoryList,
	type GithubRepositoryView,
	type Principal,
} from '@skiff/contracts';
import type { CoreContext } from './context.ts';
import { ConflictError, CoreError, NotFoundError, ValidationError } from './errors.ts';
import { githubAppJwt } from './github-runners.ts';

/**
 * Skiff's GitHub App (docs/GITHUB.md, D163–D166).
 *
 * One App per install. A platform admin registers it (GitHub's manifest flow, or pasted
 * credentials); every GitHub account that installs it is linked to one Skiff organisation. The
 * App's private key, webhook secret and OAuth secret are sealed with the platform data key and
 * only this service opens them. Everything else asks this service for what it needs:
 *
 * - `repoToken` / `ownerToken`: short-lived installation tokens, narrowed to one repository and
 *   the permissions the caller names (clone, statuses, runners);
 * - `commitStatus` / `deployment`: best-effort reporting that never throws;
 * - `deliversFor`: whether the App already delivers a repository's events, so a hand-made webhook
 *   for the same repository is ignored instead of starting a second build or run;
 * - `handleWebhook`: the App's single webhook, routed to git builds and pipelines.
 */

const SETTINGS_KEY = 'github.app';
/** Sealed with the platform data key, like the registry's secrets (D155). */
const PLATFORM_KEY_ORG = 'platform';
const API = 'https://api.github.com';
const WEB = 'https://github.com';
const API_VERSION = '2022-11-28';
const REQUEST_TIMEOUT_MS = 15_000;
/** Refresh an installation token this long before GitHub expires it (tokens live one hour). */
const TOKEN_REFRESH_MS = 5 * 60_000;
/** Signed `state` for the manifest and install round-trips. */
const STATE_TTL_MS = 60 * 60_000;
const REPOSITORY_CACHE_MS = 2 * 60_000;
/** A repository the App could not mint a token for is not retried for this long. */
const NEGATIVE_CACHE_MS = 60_000;
/** Repositories fetched per installation for pickers (100 per page). */
const MAX_REPOSITORY_PAGES = 5;

interface StoredApp {
	appId: number;
	slug: string | null;
	name: string | null;
	owner: string | null;
	htmlUrl: string | null;
	clientId: string | null;
	clientSecretSealed: string | null;
	privateKeySealed: string;
	webhookSecretSealed: string;
	source: 'manifest' | 'manual';
	createdBy: string;
	createdAt: number;
}

interface GithubAppApi {
	id: number;
	slug?: string;
	name?: string;
	html_url?: string;
	client_id?: string;
	owner?: { login?: string } | null;
}

interface GithubManifestConversion extends GithubAppApi {
	pem: string;
	webhook_secret: string | null;
	client_secret?: string;
}

interface GithubInstallationApi {
	id: number;
	account: { login: string; id: number; type: string; avatar_url?: string } | null;
	repository_selection?: string;
	permissions?: Record<string, string>;
	suspended_at?: string | null;
}

interface GithubRepoApi {
	id: number;
	name: string;
	full_name: string;
	owner: { login: string };
	private: boolean;
	archived?: boolean;
	default_branch?: string;
	clone_url: string;
	html_url: string;
	pushed_at?: string | null;
}

interface CachedToken {
	token: string;
	expiresAt: number;
}

export type InstallationRow = typeof githubInstallations.$inferSelect;

export type GithubTokenPermissions = Partial<Record<GithubAppPermission, 'read' | 'write'>>;

export interface RepoToken {
	token: string;
	installationId: number;
	owner: string;
	repo: string;
}

export interface CommitStatusReport {
	sha: string;
	state: 'pending' | 'success' | 'failure' | 'error';
	context: string;
	description: string;
	targetUrl: string;
}

export interface GithubCoverage {
	status: 'covered' | 'not-selected' | 'not-installed' | 'no-app' | 'not-github';
	fullName: string | null;
	installationId: number | null;
	/** Where to grant the repository or install the App. */
	manageUrl: string | null;
}

interface GithubContentApi {
	name: string;
	path: string;
	type: 'file' | 'dir' | 'symlink' | 'submodule';
	content?: string;
	encoding?: string;
}

export type GithubPathContent =
	| { kind: 'dir'; entries: Array<{ name: string; path: string; type: 'file' | 'dir' }> }
	| { kind: 'file'; text: string | null };

export interface GithubWebhookResult {
	accepted: boolean;
	reason?: string;
	builds?: string[];
	triggers?: string[];
}

/** The subset of a `push` payload builds and pipelines read. */
export interface GithubPushEvent {
	ref?: string;
	after?: string;
	deleted?: boolean;
	commits?: Array<{ added?: string[]; modified?: string[]; removed?: string[] }>;
	head_commit?: { message?: string } | null;
	pusher?: { name?: string };
	sender?: { login?: string };
	repository?: { full_name?: string };
	installation?: { id?: number };
}

export class GithubAppService {
	private readonly tokens = new Map<string, CachedToken>();
	private readonly negative = new Map<string, number>();
	private readonly repositoryCache = new Map<number, { at: number; repositories: GithubRepositoryView[]; truncated: boolean }>();

	constructor(private readonly ctx: CoreContext) {}

	private get fetcher(): typeof fetch {
		return this.ctx.config.githubFetch ?? fetch;
	}

	private get origin(): string {
		return this.ctx.config.platformOrigin.replace(/\/+$/, '');
	}

	// ------------------------------------------------------------------------------ app config

	private stored(): StoredApp | null {
		const row = this.ctx.db.select().from(settings).where(eq(settings.key, SETTINGS_KEY)).get();
		if (!row) return null;
		try {
			const parsed = JSON.parse(row.value) as StoredApp;
			return parsed && typeof parsed.appId === 'number' && parsed.privateKeySealed ? parsed : null;
		} catch {
			return null;
		}
	}

	private save(app: StoredApp | null): void {
		if (!app) {
			this.ctx.db.delete(settings).where(eq(settings.key, SETTINGS_KEY)).run();
			return;
		}
		const value = JSON.stringify(app);
		const now = this.ctx.now();
		this.ctx.db
			.insert(settings)
			.values({ key: SETTINGS_KEY, value, updatedAt: now })
			.onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } })
			.run();
	}

	private seal(value: string): string {
		return this.ctx.secrets.seal(PLATFORM_KEY_ORG, value);
	}

	private open(sealed: string): string {
		return this.ctx.secrets.open(PLATFORM_KEY_ORG, sealed);
	}

	configured(): boolean {
		return this.stored() !== null;
	}

	view(principal: Principal): GithubAppView {
		const app = this.stored();
		const admin = canAdministerPlatform(principal);
		const env = this.envOAuth();
		return {
			configured: Boolean(app),
			appId: app?.appId ?? null,
			slug: app?.slug ?? null,
			name: app?.name ?? null,
			htmlUrl: app?.htmlUrl ?? (app?.slug ? `${WEB}/apps/${app.slug}` : null),
			owner: app?.owner ?? null,
			clientId: admin ? (app?.clientId ?? null) : null,
			hasClientSecret: Boolean(app?.clientSecretSealed),
			source: app?.source ?? null,
			webhookUrl: `${this.origin}/api/webhooks/github-app`,
			setupUrl: `${this.origin}/settings/github/installed`,
			installUrl: app?.slug ? `${WEB}/apps/${app.slug}/installations/new` : null,
			signInReady: Boolean(env || (app?.clientId && app.clientSecretSealed)),
			signInFromEnv: Boolean(env),
			createdAt: app ? new Date(app.createdAt).toISOString() : null,
		};
	}

	private envOAuth(): boolean {
		return Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
	}

	/** OAuth client credentials for "Sign in with GitHub", when the App has them. */
	oauthCredentials(): { clientId: string; clientSecret: string } | null {
		const app = this.stored();
		if (!app?.clientId || !app.clientSecretSealed) return null;
		try {
			return { clientId: app.clientId, clientSecret: this.open(app.clientSecretSealed) };
		} catch {
			return null;
		}
	}

	private requireAdmin(principal: Principal): void {
		if (!canAdministerPlatform(principal))
			throw new CoreError('forbidden', 'Only a platform admin, signed in to the dashboard, can change the GitHub App.', 403);
	}

	/**
	 * Begin GitHub's manifest flow: the dashboard posts `manifest` to `postUrl` in the browser, and
	 * GitHub sends the admin back to `/settings/github/created?code=…&state=…`.
	 */
	startManifest(principal: Principal, input: GithubAppManifestStart): { postUrl: string; manifest: string; state: string } {
		this.requireAdmin(principal);
		if (this.configured()) throw new ConflictError('A GitHub App is already connected. Remove it first to create another.');
		const parsed = githubAppManifestStartSchema.parse(input);
		const state = this.signState({ kind: 'manifest', userId: principal.userId, orgId: principal.orgId });
		return {
			postUrl: githubAppManifestUrl(parsed.owner ?? null, state),
			manifest: JSON.stringify(githubAppManifest({ origin: this.origin, name: parsed.name, public: parsed.public })),
			state,
		};
	}

	/** Exchange the manifest code for the App's credentials and store them. */
	async completeManifest(principal: Principal, code: string, state: string): Promise<GithubAppView> {
		this.requireAdmin(principal);
		this.verifyState(state, { kind: 'manifest', userId: principal.userId });
		if (!/^[A-Za-z0-9_-]{8,128}$/.test(code)) throw new ValidationError('GitHub returned an unexpected code.');
		if (this.configured()) throw new ConflictError('A GitHub App is already connected.');
		const created = await this.request<GithubManifestConversion>(null, 'POST', `/app-manifests/${encodeURIComponent(code)}/conversions`);
		if (!created?.id || !created.pem) throw new CoreError('github_error', 'GitHub did not return the new App’s credentials.', 502);
		if (!created.webhook_secret) throw new CoreError('github_error', 'GitHub did not return a webhook secret for the new App.', 502);
		this.save({
			appId: created.id,
			slug: created.slug ?? null,
			name: created.name ?? null,
			owner: created.owner?.login ?? null,
			htmlUrl: created.html_url ?? null,
			clientId: created.client_id ?? null,
			clientSecretSealed: created.client_secret ? this.seal(created.client_secret) : null,
			privateKeySealed: this.seal(created.pem),
			webhookSecretSealed: this.seal(created.webhook_secret),
			source: 'manifest',
			createdBy: principal.userId,
			createdAt: this.ctx.now(),
		});
		this.audit(principal, 'github.app.create', String(created.id), { source: 'manifest', slug: created.slug ?? null });
		return this.view(principal);
	}

	/** Store an App created by hand on GitHub, after proving the key works. */
	async configureManual(principal: Principal, input: GithubAppManual): Promise<GithubAppView> {
		this.requireAdmin(principal);
		const parsed = githubAppManualSchema.parse(input);
		if ((parsed.clientId && !parsed.clientSecret) || (!parsed.clientId && parsed.clientSecret))
			throw new ValidationError('Enter both the client ID and the client secret, or neither.');
		const jwt = githubAppJwt(parsed.appId, parsed.privateKey, this.ctx.now());
		const app = await this.request<GithubAppApi>(jwt, 'GET', '/app');
		if (!app?.id || app.id !== parsed.appId)
			throw new ValidationError('That private key belongs to a different GitHub App. Check the App ID.');
		const existing = this.stored();
		// Re-saving the same App with the OAuth fields blank keeps the stored ones.
		const keep = existing?.appId === app.id && !parsed.clientSecret ? existing : null;
		this.save({
			appId: app.id,
			slug: app.slug ?? null,
			name: app.name ?? null,
			owner: app.owner?.login ?? null,
			htmlUrl: app.html_url ?? null,
			clientId: parsed.clientId ?? keep?.clientId ?? app.client_id ?? null,
			clientSecretSealed: parsed.clientSecret ? this.seal(parsed.clientSecret) : (keep?.clientSecretSealed ?? null),
			privateKeySealed: this.seal(`${parsed.privateKey.trim()}\n`),
			webhookSecretSealed: this.seal(parsed.webhookSecret),
			source: 'manual',
			createdBy: principal.userId,
			createdAt: existing?.appId === app.id ? existing.createdAt : this.ctx.now(),
		});
		if (existing && existing.appId !== app.id) this.forgetInstallations();
		this.tokens.clear();
		this.audit(principal, 'github.app.create', String(app.id), { source: 'manual', slug: app.slug ?? null });
		await this.syncInstallations(principal).catch(() => 0);
		return this.view(principal);
	}

	/**
	 * Forget the App. Its registration on GitHub is left alone (delete it there); builds,
	 * pipelines and runners fall back to node credentials, hand-made webhooks and stored tokens.
	 */
	remove(principal: Principal): void {
		this.requireAdmin(principal);
		const app = this.stored();
		if (!app) return;
		this.save(null);
		this.forgetInstallations();
		this.tokens.clear();
		this.negative.clear();
		this.repositoryCache.clear();
		this.audit(principal, 'github.app.remove', String(app.appId), { slug: app.slug });
	}

	private forgetInstallations(): void {
		this.ctx.db.delete(githubInstallations).run();
		this.repositoryCache.clear();
	}

	// ----------------------------------------------------------------------------- installations

	/** The org's installations, plus every unclaimed one for platform admins. */
	installations(principal: Principal): GithubInstallationView[] {
		this.ctx.iam.require(principal, 'build:read', { type: 'org' });
		const rows = this.ctx.db.select().from(githubInstallations).all();
		const admin = canAdministerPlatform(principal);
		return rows
			.filter((row) => row.orgId === principal.orgId || (admin && row.orgId === null))
			.sort((a, b) => a.accountLogin.localeCompare(b.accountLogin))
			.map((row) => this.installationView(row));
	}

	/** Every installation, for the platform admin's overview (which org each belongs to). */
	allInstallations(principal: Principal): GithubInstallationView[] {
		this.requireAdmin(principal);
		return this.ctx.db
			.select()
			.from(githubInstallations)
			.all()
			.sort((a, b) => a.accountLogin.localeCompare(b.accountLogin))
			.map((row) => this.installationView(row));
	}

	/** `github.com/apps/<slug>/installations/new?state=…`, bound to the principal's org. */
	installUrl(principal: Principal): string | null {
		const app = this.stored();
		if (!app?.slug) return null;
		const state = this.signState({ kind: 'install', userId: principal.userId, orgId: principal.orgId });
		return `${WEB}/apps/${app.slug}/installations/new?state=${encodeURIComponent(state)}`;
	}

	private canLink(principal: Principal): boolean {
		return principal.kind === 'user' && (principal.role === 'owner' || principal.role === 'admin');
	}

	/** Refresh every installation from GitHub (new ones arrive unclaimed). */
	async syncInstallations(principal?: Principal): Promise<number> {
		if (principal) this.requireAdmin(principal);
		const jwt = this.appJwt();
		const seen = new Set<number>();
		for (let page = 1; page <= 10; page++) {
			const list = await this.request<GithubInstallationApi[]>(jwt, 'GET', `/app/installations?per_page=100&page=${page}`);
			for (const installation of list ?? []) {
				this.upsertInstallation(installation);
				seen.add(installation.id);
			}
			if (!list || list.length < 100) break;
		}
		// Installations GitHub no longer lists were uninstalled while no webhook arrived.
		for (const row of this.ctx.db.select().from(githubInstallations).all())
			if (!seen.has(row.installationId)) this.deleteInstallation(row.installationId);
		return seen.size;
	}

	/**
	 * The installer comes back from GitHub (`installation_id`, `setup_action`, OAuth `code`,
	 * `state`). The installation is linked to the principal's org only when GitHub confirms, via the
	 * user's own OAuth token, that this user can see it. Without an OAuth code (an App without
	 * client credentials) only a platform admin may link it.
	 */
	async completeInstallation(
		principal: Principal,
		input: { installationId: number; code?: string | null; state?: string | null; setupAction?: string | null },
	): Promise<GithubInstallationView> {
		const app = this.requireApp();
		if (!this.canLink(principal))
			throw new CoreError('forbidden', 'Only organisation owners and admins can connect GitHub installations.', 403);
		// The signed state proves this user started the install from this org; without it a crafted
		// callback link could attach someone else's installation (and their OAuth code) to this org.
		if (input.state) this.verifyState(input.state, { kind: 'install', userId: principal.userId, orgId: principal.orgId });
		else if (!canAdministerPlatform(principal))
			throw new CoreError(
				'github_state_invalid',
				'Start the installation from Settings → GitHub → Install on GitHub so Skiff knows which organisation it is for.',
				400,
			);
		let verified = false;
		if (input.code && app.clientId && app.clientSecretSealed) {
			const userToken = await this.exchangeOAuthCode(app, input.code);
			verified = await this.userCanSee(userToken, input.installationId);
			if (!verified) throw new CoreError('forbidden', 'Your GitHub account cannot see that installation.', 403);
		} else if (!canAdministerPlatform(principal)) {
			throw new CoreError(
				'forbidden',
				'GitHub did not confirm who installed the App, so only a platform admin can link this installation. Ask one to link it from Settings → GitHub.',
				403,
			);
		}
		const installation = await this.request<GithubInstallationApi>(this.appJwt(), 'GET', `/app/installations/${input.installationId}`);
		if (!installation?.id) throw new NotFoundError('Installation');
		const row = this.upsertInstallation(installation);
		if (row.orgId && row.orgId !== principal.orgId)
			throw new ConflictError(`The installation on ${row.accountLogin} is already linked to another Skiff organisation.`);
		const linked = this.link(row, principal);
		this.audit(principal, 'github.installation.link', String(row.installationId), {
			account: row.accountLogin,
			verified: verified ? 'oauth' : 'platform-admin',
			setupAction: input.setupAction ?? null,
		});
		return this.installationView(linked);
	}

	/** A platform admin links an unclaimed installation to their current org. */
	linkInstallation(principal: Principal, installationId: number): GithubInstallationView {
		this.requireAdmin(principal);
		if (!this.canLink(principal))
			throw new CoreError('forbidden', 'Only organisation owners and admins can connect GitHub installations.', 403);
		const row = this.requireInstallation(installationId);
		if (row.orgId && row.orgId !== principal.orgId)
			throw new ConflictError(`The installation on ${row.accountLogin} is already linked to another organisation. Unlink it there first.`);
		const linked = this.link(row, principal);
		this.audit(principal, 'github.installation.link', String(installationId), { account: row.accountLogin, verified: 'platform-admin' });
		return this.installationView(linked);
	}

	/** Detach an installation from the org (it stays installed on GitHub, unclaimed). */
	unlinkInstallation(principal: Principal, installationId: number): void {
		const row = this.requireInstallation(installationId);
		const own = row.orgId === principal.orgId && this.canLink(principal);
		if (!own && !canAdministerPlatform(principal))
			throw new CoreError('forbidden', 'Only organisation owners and admins can disconnect GitHub installations.', 403);
		this.ctx.db
			.update(githubInstallations)
			.set({ orgId: null, linkedBy: null, linkedAt: null, updatedAt: this.ctx.now() })
			.where(eq(githubInstallations.installationId, installationId))
			.run();
		this.forgetTokens(installationId);
		this.audit(principal, 'github.installation.unlink', String(installationId), { account: row.accountLogin });
	}

	private link(row: InstallationRow, principal: Principal): InstallationRow {
		const now = this.ctx.now();
		const patch = { orgId: principal.orgId, linkedBy: principal.userId, linkedAt: row.linkedAt ?? now, updatedAt: now };
		this.ctx.db.update(githubInstallations).set(patch).where(eq(githubInstallations.installationId, row.installationId)).run();
		return { ...row, ...patch };
	}

	private requireInstallation(installationId: number): InstallationRow {
		const row = this.ctx.db.select().from(githubInstallations).where(eq(githubInstallations.installationId, installationId)).get();
		if (!row) throw new NotFoundError('Installation');
		return row;
	}

	private upsertInstallation(installation: GithubInstallationApi): InstallationRow {
		const now = this.ctx.now();
		const values = {
			accountLogin: installation.account?.login ?? 'unknown',
			accountId: installation.account?.id ?? 0,
			accountType: installation.account?.type ?? 'User',
			avatarUrl: installation.account?.avatar_url ?? null,
			repositorySelection: installation.repository_selection ?? 'selected',
			permissionsJson: JSON.stringify(installation.permissions ?? {}),
			suspendedAt: installation.suspended_at ? Date.parse(installation.suspended_at) || now : null,
			updatedAt: now,
		};
		this.ctx.db
			.insert(githubInstallations)
			.values({ installationId: installation.id, ...values, createdAt: now })
			.onConflictDoUpdate({ target: githubInstallations.installationId, set: values })
			.run();
		this.repositoryCache.delete(installation.id);
		return this.requireInstallation(installation.id);
	}

	private deleteInstallation(installationId: number): void {
		this.ctx.db.delete(githubInstallations).where(eq(githubInstallations.installationId, installationId)).run();
		this.forgetTokens(installationId);
	}

	private forgetTokens(installationId: number): void {
		for (const key of this.tokens.keys()) if (key.startsWith(`${installationId}:`)) this.tokens.delete(key);
		this.repositoryCache.delete(installationId);
		this.negative.clear();
	}

	private installationView(row: InstallationRow): GithubInstallationView {
		const permissions = parseRecord(row.permissionsJson);
		const orgName = row.orgId ? this.orgName(row.orgId) : null;
		return {
			id: row.installationId,
			account: { login: row.accountLogin, type: row.accountType, avatarUrl: row.avatarUrl },
			repositorySelection: row.repositorySelection,
			permissions,
			missingPermissions: missingPermissions(permissions),
			suspended: row.suspendedAt !== null,
			orgId: row.orgId,
			orgName,
			settingsUrl:
				row.accountType === 'Organization'
					? `${WEB}/organizations/${encodeURIComponent(row.accountLogin)}/settings/installations/${row.installationId}`
					: `${WEB}/settings/installations/${row.installationId}`,
			linkedAt: row.linkedAt ? new Date(row.linkedAt).toISOString() : null,
			updatedAt: new Date(row.updatedAt).toISOString(),
		};
	}

	private orgName(orgId: string): string | null {
		try {
			const row = this.ctx.sqlite.query<{ name: string }, [string]>('SELECT name FROM organization WHERE id = ?').get(orgId);
			return row?.name ?? null;
		} catch {
			return null;
		}
	}

	/** Linked, active installations of an org. */
	private orgInstallations(orgId: string): InstallationRow[] {
		return this.ctx.db
			.select()
			.from(githubInstallations)
			.where(and(eq(githubInstallations.orgId, orgId), isNull(githubInstallations.suspendedAt)))
			.all();
	}

	private installationsFor(orgId: string, owner: string): InstallationRow[] {
		if (!this.configured()) return [];
		return this.orgInstallations(orgId).filter((row) => row.accountLogin.toLowerCase() === owner.toLowerCase());
	}

	/** Whether an org can use the App for `owner` (any linked installation on that account). */
	hasInstallationFor(orgId: string, owner: string): boolean {
		return this.installationsFor(orgId, owner).length > 0;
	}

	/** What the App does for a repository URL in an org, for dashboard hints (no network). */
	repositoryLink(orgId: string, url: string): GithubRepositoryLink {
		const parsed = parseGithubRepoUrl(url);
		if (!parsed) return { fullName: null, installationId: null };
		const installation = this.installationsFor(orgId, parsed.owner)[0];
		return { fullName: `${parsed.owner}/${parsed.repo}`, installationId: installation?.installationId ?? null };
	}

	// ------------------------------------------------------------------------------ repositories

	/** Every repository the org's installations can reach, for pickers. Best effort. */
	async repositories(principal: Principal, options: { refresh?: boolean } = {}): Promise<GithubRepositoryList> {
		this.ctx.iam.require(principal, 'build:read', { type: 'org' });
		const installations = this.orgInstallations(principal.orgId);
		const app = this.stored();
		const result: GithubRepositoryList = {
			connected: Boolean(app) && installations.length > 0,
			repositories: [],
			truncated: false,
			error: null,
			manageUrl: installations[0] ? this.installationView(installations[0]).settingsUrl : app?.slug ? `${WEB}/apps/${app.slug}/installations/new` : null,
		};
		if (!app) return result;
		for (const installation of installations) {
			try {
				const listed = await this.installationRepositories(installation.installationId, options.refresh === true);
				result.repositories.push(...listed.repositories);
				result.truncated ||= listed.truncated;
			} catch (error) {
				result.error = error instanceof Error ? error.message : String(error);
			}
		}
		result.repositories.sort((a, b) => a.fullName.localeCompare(b.fullName));
		return result;
	}

	private async installationRepositories(
		installationId: number,
		refresh: boolean,
	): Promise<{ repositories: GithubRepositoryView[]; truncated: boolean }> {
		const cached = this.repositoryCache.get(installationId);
		if (cached && !refresh && cached.at + REPOSITORY_CACHE_MS > this.ctx.now()) return cached;
		const token = await this.installationToken(installationId, {});
		const repositories: GithubRepositoryView[] = [];
		let truncated = false;
		for (let page = 1; page <= MAX_REPOSITORY_PAGES; page++) {
			const listed = await this.request<{ total_count: number; repositories: GithubRepoApi[] }>(
				token,
				'GET',
				`/installation/repositories?per_page=100&page=${page}`,
			);
			for (const repo of listed?.repositories ?? []) repositories.push(repoView(repo, installationId));
			if (!listed || listed.repositories.length < 100) break;
			if (page === MAX_REPOSITORY_PAGES) truncated = listed.total_count > repositories.length;
		}
		const entry = { at: this.ctx.now(), repositories, truncated };
		this.repositoryCache.set(installationId, entry);
		return entry;
	}

	/**
	 * Whether the App delivers events for `owner/repo` in this org: a hand-made webhook for the
	 * same repository is then ignored, so one push never starts two builds or runs. When GitHub
	 * cannot be asked, the answer is "no" (a possible duplicate beats a lost event).
	 */
	async deliversFor(orgId: string, fullName: string): Promise<boolean> {
		const [owner] = fullName.split('/');
		if (!owner) return false;
		for (const installation of this.installationsFor(orgId, owner)) {
			if (installation.repositorySelection === 'all') return true;
			try {
				const listed = await this.installationRepositories(installation.installationId, false);
				if (listed.repositories.some((repo) => sameGithubRepo(repo.fullName, fullName))) return true;
			} catch {
				return false;
			}
		}
		return false;
	}

	/**
	 * How the App covers a repository URL in an org, asking GitHub when the cached list is stale:
	 * `covered` (events, clones and statuses need nothing else), `not-selected` (installed on the
	 * owner, but the repository is not among the installation's selected ones), `not-installed`,
	 * `no-app` or `not-github`. `manageUrl` is where to fix it.
	 */
	async coverage(orgId: string, url: string): Promise<GithubCoverage> {
		const parsed = parseGithubRepoUrl(url);
		if (!parsed) return { status: 'not-github', fullName: null, installationId: null, manageUrl: null };
		const fullName = `${parsed.owner}/${parsed.repo}`;
		const app = this.stored();
		if (!app) return { status: 'no-app', fullName, installationId: null, manageUrl: null };
		const installations = this.installationsFor(orgId, parsed.owner);
		const install = app.slug ? `${WEB}/apps/${app.slug}/installations/new` : null;
		if (installations.length === 0) return { status: 'not-installed', fullName, installationId: null, manageUrl: install };
		for (const installation of installations) {
			if (installation.repositorySelection === 'all')
				return { status: 'covered', fullName, installationId: installation.installationId, manageUrl: null };
			try {
				const listed = await this.installationRepositories(installation.installationId, false);
				if (listed.repositories.some((repo) => sameGithubRepo(repo.fullName, fullName)))
					return { status: 'covered', fullName, installationId: installation.installationId, manageUrl: null };
			} catch {
				// GitHub could not be asked: say what the owner match suggests rather than "not covered".
				return { status: 'covered', fullName, installationId: installation.installationId, manageUrl: null };
			}
		}
		const first = installations[0]!;
		return { status: 'not-selected', fullName, installationId: first.installationId, manageUrl: this.installationView(first).settingsUrl };
	}

	/** One repository of the org, through the App. Null when no installation reaches it. */
	async repository(orgId: string, fullName: string): Promise<GithubRepositoryView | null> {
		const access = await this.repoToken(orgId, `${WEB}/${fullName}`, { contents: 'read' });
		if (!access) return null;
		const repo = await this.request<GithubRepoApi>(access.token, 'GET', repoPath(access), undefined, { allowNotFound: true });
		return repo ? repoView(repo, access.installationId) : null;
	}

	/**
	 * Read a path of a repository at `ref` through the App (contents API): a directory listing or a
	 * file's text (files over 1 MB are not returned). Null when the path does not exist; throws when
	 * the App does not reach the repository or GitHub fails.
	 */
	async readPath(orgId: string, fullName: string, path: string, ref?: string): Promise<GithubPathContent | null> {
		const access = await this.repoToken(orgId, `${WEB}/${fullName}`, { contents: 'read' });
		if (!access)
			throw new CoreError(
				'github_installation_missing',
				`Skiff's GitHub App cannot reach ${fullName} for this organisation. Install it, or grant it the repository, in Settings → GitHub.`,
				409,
			);
		const clean = path.replace(/^\.?\/+/, '').replace(/\/+$/, '');
		const encoded = clean && clean !== '.' ? `/${clean.split('/').map(encodeURIComponent).join('/')}` : '';
		const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
		const found = await this.request<GithubContentApi | GithubContentApi[]>(
			access.token,
			'GET',
			`${repoPath(access)}/contents${encoded}${query}`,
			undefined,
			{ allowNotFound: true },
		);
		if (!found) return null;
		if (Array.isArray(found))
			return { kind: 'dir', entries: found.map((entry) => ({ name: entry.name, path: entry.path, type: entry.type === 'dir' ? 'dir' : 'file' })) };
		if (found.type !== 'file') return null;
		const text = found.encoding === 'base64' && typeof found.content === 'string' ? Buffer.from(found.content, 'base64').toString('utf8') : null;
		return { kind: 'file', text };
	}

	// ------------------------------------------------------------------------------------ tokens

	private requireApp(): StoredApp {
		const app = this.stored();
		if (!app) throw new CoreError('github_app_missing', 'No GitHub App is connected. A platform admin can add one in Settings → GitHub.', 409);
		return app;
	}

	private appJwt(): string {
		const app = this.requireApp();
		return githubAppJwt(app.appId, this.open(app.privateKeySealed), this.ctx.now());
	}

	/** An installation token, optionally narrowed to some repositories and permissions; cached. */
	async installationToken(
		installationId: number,
		scope: { repositories?: string[]; permissions?: GithubTokenPermissions },
	): Promise<string> {
		const repositories = scope.repositories?.map((name) => name.toLowerCase()).sort();
		const permissions = scope.permissions
			? Object.fromEntries(Object.entries(scope.permissions).sort(([a], [b]) => a.localeCompare(b)))
			: undefined;
		const key = `${installationId}:${JSON.stringify(repositories ?? null)}:${JSON.stringify(permissions ?? null)}`;
		const cached = this.tokens.get(key);
		if (cached && cached.expiresAt - TOKEN_REFRESH_MS > this.ctx.now()) return cached.token;
		const body: Record<string, unknown> = {};
		if (repositories) body.repositories = repositories;
		if (permissions) body.permissions = permissions;
		const issued = await this.request<{ token: string; expires_at: string }>(
			this.appJwt(),
			'POST',
			`/app/installations/${installationId}/access_tokens`,
			Object.keys(body).length ? body : undefined,
		);
		if (!issued?.token) throw new CoreError('github_error', 'GitHub did not issue an installation token.', 502);
		const expiresAt = Date.parse(issued.expires_at);
		this.tokens.set(key, { token: issued.token, expiresAt: Number.isFinite(expiresAt) ? expiresAt : this.ctx.now() + 60 * 60_000 });
		return issued.token;
	}

	/**
	 * A token for one github.com repository of the org, with only `permissions`, or null when the
	 * URL is not GitHub, no installation covers it, or GitHub refuses. Never throws.
	 */
	async repoToken(orgId: string, repoUrl: string, permissions: GithubTokenPermissions): Promise<RepoToken | null> {
		const parsed = parseGithubRepoUrl(repoUrl);
		if (!parsed) return null;
		const negativeKey = `${orgId}:${parsed.owner}/${parsed.repo}:${JSON.stringify(permissions)}`.toLowerCase();
		const until = this.negative.get(negativeKey);
		if (until && until > this.ctx.now()) return null;
		for (const installation of this.installationsFor(orgId, parsed.owner)) {
			try {
				const token = await this.installationToken(installation.installationId, { repositories: [parsed.repo], permissions });
				return { token, installationId: installation.installationId, owner: parsed.owner, repo: parsed.repo };
			} catch (error) {
				console.warn(`[github] no token for ${parsed.owner}/${parsed.repo}: ${(error as Error).message}`);
			}
		}
		this.negative.set(negativeKey, this.ctx.now() + NEGATIVE_CACHE_MS);
		return null;
	}

	/**
	 * A token on an account (runner pools): the org's installation on `owner`, narrowed to one
	 * repository when given. Throws a message the Worker card can show.
	 */
	async ownerToken(orgId: string, owner: string, scope: { repo?: string; permissions: GithubTokenPermissions }): Promise<string> {
		this.requireApp();
		const installation = this.installationsFor(orgId, owner)[0];
		if (!installation)
			throw new CoreError(
				'github_installation_missing',
				`Skiff's GitHub App is not installed on ${owner} for this organisation. Install it from Settings → GitHub.`,
				409,
			);
		return this.installationToken(installation.installationId, {
			...(scope.repo ? { repositories: [scope.repo] } : {}),
			permissions: scope.permissions,
		});
	}

	// ---------------------------------------------------------------------------------- reporting

	/** Best-effort commit status through the App. False when the App does not cover the repo. */
	async commitStatus(orgId: string, repoUrl: string, report: CommitStatusReport): Promise<boolean> {
		if (!/^[a-f0-9]{40}$/i.test(report.sha)) return false;
		const access = await this.repoToken(orgId, repoUrl, { statuses: 'write' });
		if (!access) return false;
		try {
			await this.request(access.token, 'POST', `${repoPath(access)}/statuses/${report.sha}`, {
				state: report.state,
				context: report.context.slice(0, 255),
				description: report.description.slice(0, 140),
				target_url: report.targetUrl,
			});
			return true;
		} catch (error) {
			console.warn(`[github] commit status on ${access.owner}/${access.repo}@${report.sha.slice(0, 7)} failed: ${(error as Error).message}`);
			return false;
		}
	}

	/**
	 * Record a deployment on GitHub (the repository's "Deployments" list and the commit's
	 * environment badge). Returns the GitHub deployment id, or null. Never throws.
	 */
	async deployment(
		orgId: string,
		repoUrl: string,
		input: { sha: string; environment: string; production: boolean; description: string; environmentUrl: string; logUrl: string; state: 'success' | 'failure' | 'error' },
	): Promise<number | null> {
		if (!/^[a-f0-9]{40}$/i.test(input.sha)) return null;
		const access = await this.repoToken(orgId, repoUrl, { deployments: 'write' });
		if (!access) return null;
		try {
			const created = await this.request<{ id: number }>(access.token, 'POST', `${repoPath(access)}/deployments`, {
				ref: input.sha,
				environment: input.environment,
				description: input.description.slice(0, 140),
				auto_merge: false,
				required_contexts: [],
				transient_environment: !input.production,
				production_environment: input.production,
			});
			if (!created?.id) return null;
			await this.request(access.token, 'POST', `${repoPath(access)}/deployments/${created.id}/statuses`, {
				state: input.state,
				environment_url: input.environmentUrl,
				log_url: input.logUrl,
				description: input.description.slice(0, 140),
				auto_inactive: input.production,
			});
			return created.id;
		} catch (error) {
			console.warn(`[github] deployment on ${access.owner}/${access.repo} failed: ${(error as Error).message}`);
			return null;
		}
	}

	// ----------------------------------------------------------------------------------- webhook

	/**
	 * The App's webhook. Signed with the App's webhook secret (mandatory, D45). Installation events
	 * keep `github_installations` current; `push` and `pull_request` from a linked installation go
	 * to the org's git builds and pipelines whose repository URL names the same repository.
	 */
	async handleWebhook(rawBody: string, signature: string | null, event: string | null): Promise<GithubWebhookResult> {
		const app = this.stored();
		if (!app) throw new CoreError('github_app_missing', 'No GitHub App is connected.', 404);
		if (!verifyHubSignature(this.open(app.webhookSecretSealed), rawBody, signature))
			throw new CoreError('unauthorized', 'Invalid webhook signature.', 401);
		let payload: Record<string, unknown>;
		try {
			payload = JSON.parse(rawBody) as Record<string, unknown>;
		} catch {
			throw new ValidationError('GitHub payload is not valid JSON.');
		}
		if (event === 'ping') return { accepted: true, reason: 'pong' };
		if (event === 'installation') return this.onInstallation(payload);
		if (event === 'installation_repositories') {
			const installation = payload.installation as GithubInstallationApi | undefined;
			if (installation?.id) {
				this.upsertInstallation(installation);
				this.forgetTokens(installation.id);
			}
			return { accepted: true, reason: 'repositories updated' };
		}
		if (event === 'github_app_authorization') return { accepted: true, reason: 'ignored' };
		if (event !== 'push' && event !== 'pull_request') return { accepted: false, reason: `event ${event ?? '(none)'} is not handled` };

		const installationId = (payload.installation as { id?: number } | undefined)?.id;
		const fullName = (payload.repository as { full_name?: string } | undefined)?.full_name;
		if (!installationId || !fullName) return { accepted: false, reason: 'no installation or repository' };
		const row = this.ctx.db.select().from(githubInstallations).where(eq(githubInstallations.installationId, installationId)).get();
		if (!row) {
			// An installation created while the webhook was down: record it, unclaimed.
			await this.syncInstallations().catch(() => 0);
			return { accepted: false, reason: 'installation is not linked to an organisation' };
		}
		if (!row.orgId) return { accepted: false, reason: 'installation is not linked to an organisation' };
		if (row.suspendedAt) return { accepted: false, reason: 'installation is suspended' };

		const result: GithubWebhookResult = { accepted: false, builds: [], triggers: [] };
		if (event === 'push') {
			result.builds = await this.ctx.builds.handleAppPush(row.orgId, fullName, payload as GithubPushEvent);
		}
		result.triggers = await this.ctx.pipelines.handleAppEvent(row.orgId, fullName, event, payload);
		result.accepted = (result.builds?.length ?? 0) + (result.triggers?.length ?? 0) > 0;
		if (!result.accepted) result.reason = `nothing in this organisation builds ${fullName} for this event`;
		return result;
	}

	private onInstallation(payload: Record<string, unknown>): GithubWebhookResult {
		const action = String(payload.action ?? '');
		const installation = payload.installation as GithubInstallationApi | undefined;
		if (!installation?.id) return { accepted: false, reason: 'no installation' };
		if (action === 'deleted') {
			this.deleteInstallation(installation.id);
			return { accepted: true, reason: 'installation removed' };
		}
		this.upsertInstallation(installation);
		if (action === 'suspend' || action === 'unsuspend' || action === 'new_permissions_accepted') this.forgetTokens(installation.id);
		return { accepted: true, reason: `installation ${action}` };
	}

	// ------------------------------------------------------------------------------------- OAuth

	private async exchangeOAuthCode(app: StoredApp, code: string): Promise<string> {
		if (!/^[A-Za-z0-9_-]{8,128}$/.test(code)) throw new ValidationError('GitHub returned an unexpected code.');
		let response: Response;
		try {
			response = await this.fetcher(`${WEB}/login/oauth/access_token`, {
				method: 'POST',
				headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'skiff' },
				body: JSON.stringify({ client_id: app.clientId, client_secret: this.open(app.clientSecretSealed!), code }),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
		} catch (error) {
			throw new CoreError('github_unreachable', `GitHub could not be reached: ${(error as Error).message}`, 502);
		}
		const payload = (await response.json().catch(() => ({}))) as { access_token?: string; error_description?: string };
		if (!response.ok || !payload.access_token)
			throw new CoreError('github_error', `GitHub did not confirm the installation (${payload.error_description ?? `HTTP ${response.status}`}).`, 502);
		return payload.access_token;
	}

	private async userCanSee(userToken: string, installationId: number): Promise<boolean> {
		for (let page = 1; page <= 10; page++) {
			const listed = await this.request<{ installations: Array<{ id: number }> }>(userToken, 'GET', `/user/installations?per_page=100&page=${page}`);
			if (listed?.installations.some((entry) => entry.id === installationId)) return true;
			if (!listed || listed.installations.length < 100) return false;
		}
		return false;
	}

	// --------------------------------------------------------------------------------- internals

	private stateKey(): Buffer {
		return createHmac('sha256', Buffer.from(this.ctx.config.masterKey)).update('skiff/github-app-state').digest();
	}

	private signState(claims: { kind: 'manifest' | 'install'; userId: string; orgId: string }): string {
		const body = Buffer.from(JSON.stringify({ ...claims, exp: this.ctx.now() + STATE_TTL_MS })).toString('base64url');
		const mac = createHmac('sha256', this.stateKey()).update(body).digest('base64url');
		return `${body}.${mac}`;
	}

	private verifyState(state: string, expected: { kind: 'manifest' | 'install'; userId: string; orgId?: string }): void {
		const [body, mac] = state.split('.');
		const fail = () => new CoreError('github_state_invalid', 'This GitHub link has expired or was started by someone else. Start again from Settings → GitHub.', 400);
		if (!body || !mac) throw fail();
		const want = createHmac('sha256', this.stateKey()).update(body).digest('base64url');
		if (want.length !== mac.length || !timingSafeEqual(Buffer.from(want), Buffer.from(mac))) throw fail();
		let claims: { kind?: string; userId?: string; orgId?: string; exp?: number };
		try {
			claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as typeof claims;
		} catch {
			throw fail();
		}
		if (claims.kind !== expected.kind || claims.userId !== expected.userId || !claims.exp || claims.exp < this.ctx.now()) throw fail();
		if (expected.orgId && claims.orgId !== expected.orgId)
			throw new CoreError('github_state_invalid', 'You switched organisation while installing the App. Switch back, or start again from Settings → GitHub.', 400);
	}

	private async request<T>(
		token: string | null,
		method: 'GET' | 'POST' | 'DELETE' | 'PATCH',
		path: string,
		body?: unknown,
		options: { allowNotFound?: boolean } = {},
	): Promise<T | null> {
		let response: Response;
		try {
			response = await this.fetcher(`${API}${path}`, {
				method,
				headers: {
					accept: 'application/vnd.github+json',
					...(token ? { authorization: `Bearer ${token}` } : {}),
					'x-github-api-version': API_VERSION,
					'user-agent': 'skiff-github-app',
					...(body === undefined ? {} : { 'content-type': 'application/json' }),
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
		} catch (error) {
			throw new CoreError('github_unreachable', `GitHub could not be reached: ${error instanceof Error ? error.message : String(error)}`, 502);
		}
		if (response.status === 404 && options.allowNotFound) return null;
		if (!response.ok) {
			let detail = '';
			try {
				const payload = (await response.json()) as { message?: unknown };
				if (typeof payload.message === 'string') detail = payload.message;
			} catch {
				// Non-JSON error body.
			}
			const reason = detail || `HTTP ${response.status}`;
			throw new CoreError(
				'github_error',
				response.status === 401 ? `GitHub rejected the App's credentials (${reason}).` : `GitHub returned an error (${reason}).`,
				502,
			);
		}
		if (response.status === 204) return null;
		return (await response.json()) as T;
	}

	private audit(principal: Principal, action: string, resourceId: string, args: Record<string, unknown>): void {
		this.ctx.audit.record({ principal, action, resource: 'platform', resourceId, args, result: 'ok' });
	}
}

function repoPath(access: { owner: string; repo: string }): string {
	return `/repos/${encodeURIComponent(access.owner)}/${encodeURIComponent(access.repo)}`;
}

function repoView(repo: GithubRepoApi, installationId: number): GithubRepositoryView {
	return {
		id: repo.id,
		fullName: repo.full_name,
		owner: repo.owner.login,
		name: repo.name,
		private: repo.private,
		archived: repo.archived ?? false,
		defaultBranch: repo.default_branch ?? 'main',
		cloneUrl: repo.clone_url,
		htmlUrl: repo.html_url,
		installationId,
		pushedAt: repo.pushed_at ?? null,
	};
}

function parseRecord(json: string): Record<string, string> {
	try {
		const value = JSON.parse(json) as unknown;
		return value && typeof value === 'object' ? (value as Record<string, string>) : {};
	} catch {
		return {};
	}
}

/** GitHub's `X-Hub-Signature-256: sha256=<hex HMAC(secret, body)>`, compared in constant time. */
export function verifyHubSignature(secret: string, rawBody: string, signature: string | null): boolean {
	if (!signature) return false;
	const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
	const given = signature.trim();
	return expected.length === given.length && timingSafeEqual(Buffer.from(expected), Buffer.from(given));
}
