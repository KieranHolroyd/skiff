import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { and, eq } from 'drizzle-orm';
import { forgeConnections, forgeWebhooks, gitSources, pipelineRepositories, projects } from '@yoal/db';
import {
	FORGE_LABELS,
	canAdministerPlatform,
	forgeBaseKey,
	forgeConnectionCreateSchema,
	forgeConnectionUpdateSchema,
	forgeFullName,
	forgeWebhookCreateSchema,
	parseRepoUrl,
	type ForgeConnectionCreate,
	type ForgeConnectionUpdate,
	type ForgeConnectionView,
	type ForgeKind,
	type ForgeWebhookCreate,
	type ForgeWebhookView,
	type GitRepositoryView,
	type Principal,
} from '@yoal/contracts';
import type { CoreContext } from '../context.ts';
import { ConflictError, CoreError, NotFoundError, ValidationError } from '../errors.ts';
import type { GithubPathContent } from '../github-app.ts';
import { newId, randomToken } from '../util.ts';
import { isPrivateAddress } from '../log-drains.ts';
import {
	forgeClient,
	type ForgeClient,
	type ForgeCloneCredential,
	type ForgeDeploymentInput,
	type ForgeRepo,
	type ForgeStatusReport,
	type HookScope,
} from './clients.ts';
import { normaliseForgeEvent, verifyDelivery, webhookEventName, webhookSource, type HeaderReader } from './events.ts';

/**
 * GitLab, Gitea and Forgejo connections (docs/FORGES.md, D173–D177).
 *
 * An org stores a forge's base URL and API token; this service is the only code that opens it.
 * Everything else asks for what it needs: clone credentials for one repository (`cloneAuth`),
 * best-effort statuses and deployments, repository lists and file reads, webhooks created on the
 * forge (`ensureWebhook`), and the connection's webhook receiver (`handleWebhook`), which routes
 * normalised events to git builds and pipelines.
 */

export type ForgeConnectionRow = typeof forgeConnections.$inferSelect;
type WebhookRow = typeof forgeWebhooks.$inferSelect;

const REPOSITORY_CACHE_MS = 2 * 60_000;
const MAX_REPOSITORY_PAGES = 5;
/** Deploy tokens live two days; one is reused until a day is left. */
const CLONE_REUSE_MARGIN_MS = 24 * 60 * 60_000;
/** A repository a credential could not be minted for is not retried for this long. */
const NEGATIVE_CACHE_MS = 60_000;

export interface ForgeCloneAuth {
	host: string;
	username: string;
	token: string;
}

/** How a connected forge delivers a repository's events (pipeline set-up hints, D174). */
export interface ForgeCoverage {
	status: 'covered' | 'not-hooked' | 'no-connection';
	connectionId: string | null;
	connectionName: string | null;
	fullName: string | null;
	/** The forge's refusal the last time Yoal tried to create the webhook. */
	error: string | null;
}

export interface ForgeWebhookResult {
	accepted: boolean;
	reason?: string;
	builds?: string[];
	triggers?: string[];
}

export class ForgeService {
	private readonly repositoryCache = new Map<string, { at: number; repositories: ForgeRepo[]; truncated: boolean }>();
	private readonly cloneCache = new Map<string, ForgeCloneCredential>();
	private readonly negative = new Map<string, number>();

	/** Test seam: the resolver used for the egress check. */
	resolveHost: (hostname: string) => Promise<string[]> = async (hostname) =>
		(await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

	constructor(private readonly ctx: CoreContext) {}

	/** Whether `baseUrl`'s host is (or resolves to) a private, loopback or link-local address. */
	async isPrivateHost(baseUrl: string): Promise<boolean> {
		const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '');
		if (/^localhost$|\.localhost$|\.local$|\.internal$|\.lan$|\.home\.arpa$/i.test(host)) return true;
		const addresses = isIP(host) ? [host] : await this.resolveHost(host).catch(() => [] as string[]);
		if (addresses.length === 0) throw new ValidationError(`${host} does not resolve.`);
		return addresses.some(isPrivateAddress);
	}

	/**
	 * The transport for one connection. Unless a platform admin allowed private networks for it,
	 * every request re-checks that the host still resolves to public addresses (DNS rebinding).
	 * The injected test transport skips the check.
	 */
	private fetcherFor(allowPrivate: boolean): typeof fetch {
		const injected = this.ctx.config.forgeFetch;
		if (injected) return injected;
		if (allowPrivate) return fetch;
		return (async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			if (await this.isPrivateHost(url.origin))
				throw new CoreError('forge_private_network', `${url.host} is on a private network. A platform admin can connect it.`, 409);
			return fetch(input, init);
		}) as typeof fetch;
	}

	/** Refuse a private instance unless a platform admin is connecting it; returns the flag to store. */
	private async privateNetworkFor(principal: Principal, baseUrl: string): Promise<boolean> {
		if (this.ctx.config.forgeFetch) return false;
		if (!(await this.isPrivateHost(baseUrl))) return false;
		if (!canAdministerPlatform(principal))
			throw new CoreError(
				'forbidden',
				`${new URL(baseUrl).host} is on a private network. Only a platform admin, from the dashboard, can connect a forge there.`,
				403,
			);
		return true;
	}

	private get origin(): string {
		return this.ctx.config.platformOrigin.replace(/\/+$/, '');
	}

	webhookUrl(connectionId: string): string {
		return `${this.origin}/api/webhooks/forge/${connectionId}`;
	}

	// ------------------------------------------------------------------------------ connections

	/** Whether the principal may add, edit or remove git provider connections (D173). */
	canManage(principal: Principal): boolean {
		return isOrgManager(principal) && this.ctx.iam.can(principal, 'build:create', { type: 'org' });
	}

	private requireManager(principal: Principal): void {
		this.ctx.iam.require(principal, 'build:create', { type: 'org' });
		if (!isOrgManager(principal))
			throw new CoreError('forbidden', 'Only org owners and admins can manage git provider connections.', 403);
	}

	private rows(orgId: string): ForgeConnectionRow[] {
		return this.ctx.db.select().from(forgeConnections).where(eq(forgeConnections.orgId, orgId)).all();
	}

	/** A connection by id, for code that already checked the caller (e.g. the import service). */
	row(orgId: string, id: string): ForgeConnectionRow {
		const row = this.ctx.db
			.select()
			.from(forgeConnections)
			.where(and(eq(forgeConnections.id, id), eq(forgeConnections.orgId, orgId)))
			.get();
		if (!row) throw new NotFoundError('Git provider connection');
		return row;
	}

	private webhookRows(connectionId: string): WebhookRow[] {
		return this.ctx.db.select().from(forgeWebhooks).where(eq(forgeWebhooks.connectionId, connectionId)).all();
	}

	private view(row: ForgeConnectionRow): ForgeConnectionView {
		return {
			id: row.id,
			kind: row.kind,
			name: row.name,
			baseUrl: row.baseUrl,
			accountLogin: row.accountLogin,
			hasCloneToken: Boolean(row.cloneTokenSealed),
			cloneLogin: row.cloneLogin,
			webhookUrl: this.webhookUrl(row.id),
			webhooks: this.webhookRows(row.id)
				.sort((a, b) => (a.scope === b.scope ? a.path.localeCompare(b.path) : a.scope === 'namespace' ? -1 : 1))
				.map((hook) => this.webhookView(hook)),
			createdAt: new Date(row.createdAt).toISOString(),
			updatedAt: new Date(row.updatedAt).toISOString(),
		};
	}

	private webhookView(row: WebhookRow): ForgeWebhookView {
		return {
			id: row.id,
			scope: row.scope,
			path: row.path,
			hookId: row.hookId,
			error: row.error,
			createdAt: new Date(row.createdAt).toISOString(),
			updatedAt: new Date(row.updatedAt).toISOString(),
		};
	}

	list(principal: Principal): ForgeConnectionView[] {
		this.ctx.iam.require(principal, 'build:read', { type: 'org' });
		return this.rows(principal.orgId)
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((row) => this.view(row));
	}

	get(principal: Principal, id: string): ForgeConnectionView {
		this.ctx.iam.require(principal, 'build:read', { type: 'org' });
		return this.view(this.row(principal.orgId, id));
	}

	/** Lightweight list for pickers and views (no webhooks). */
	summaries(orgId: string): Array<{ id: string; kind: ForgeKind; name: string; baseUrl: string }> {
		return this.rows(orgId).map((row) => ({ id: row.id, kind: row.kind, name: row.name, baseUrl: row.baseUrl }));
	}

	private clientFor(kind: ForgeKind, baseUrl: string, token: string, allowPrivate: boolean): ForgeClient {
		return forgeClient({ kind, baseUrl, token, fetch: this.fetcherFor(allowPrivate) });
	}

	private client(row: ForgeConnectionRow): ForgeClient {
		return this.clientFor(row.kind, row.baseUrl, this.ctx.secrets.open(row.orgId, row.tokenSealed), row.allowPrivateNetwork);
	}

	/** Prove the token(s), then store the connection. */
	async create(principal: Principal, input: ForgeConnectionCreate): Promise<ForgeConnectionView> {
		this.requireManager(principal);
		const parsed = forgeConnectionCreateSchema.parse(input);
		const baseKey = forgeBaseKey(parsed.baseUrl);
		if (!baseKey) throw new ValidationError('Enter the instance URL, e.g. https://gitlab.com.');
		if (baseKey === 'github.com' || baseKey.endsWith('.github.com'))
			throw new ValidationError('GitHub connects through Yoal’s GitHub App, in Settings → GitHub.');
		if (this.rows(principal.orgId).some((row) => forgeBaseKey(row.baseUrl) === baseKey))
			throw new ConflictError(`${parsed.baseUrl} is already connected. Update its token instead.`);
		const allowPrivate = await this.privateNetworkFor(principal, parsed.baseUrl);
		const account = await this.clientFor(parsed.kind, parsed.baseUrl, parsed.token, allowPrivate).user();
		const clone = parsed.cloneToken ? await this.clientFor(parsed.kind, parsed.baseUrl, parsed.cloneToken, allowPrivate).user() : null;
		const now = this.ctx.now();
		const row: ForgeConnectionRow = {
			id: newId('fgc_'),
			orgId: principal.orgId,
			kind: parsed.kind,
			name: parsed.name ?? new URL(parsed.baseUrl).host,
			baseUrl: parsed.baseUrl,
			tokenSealed: this.ctx.secrets.seal(principal.orgId, parsed.token),
			cloneTokenSealed: parsed.cloneToken ? this.ctx.secrets.seal(principal.orgId, parsed.cloneToken) : null,
			webhookSecretSealed: this.ctx.secrets.seal(principal.orgId, randomToken(32)),
			accountLogin: account.login,
			cloneLogin: clone?.login ?? null,
			allowPrivateNetwork: allowPrivate,
			createdBy: principal.userId,
			createdAt: now,
			updatedAt: now,
		};
		this.ctx.db.insert(forgeConnections).values(row).run();
		this.audit(principal, 'git.connection.create', row.id, { kind: row.kind, baseUrl: row.baseUrl, account: account.login });
		// Like installing the GitHub App: repositories the org already builds start delivering now.
		await this.backfill(row.id);
		return this.view(row);
	}

	async update(principal: Principal, id: string, input: ForgeConnectionUpdate): Promise<ForgeConnectionView> {
		this.requireManager(principal);
		const row = this.row(principal.orgId, id);
		const parsed = forgeConnectionUpdateSchema.parse(input);
		const patch: Partial<ForgeConnectionRow> = { updatedAt: this.ctx.now() };
		if (parsed.name) patch.name = parsed.name;
		if (parsed.token) {
			patch.accountLogin = (await this.clientFor(row.kind, row.baseUrl, parsed.token, row.allowPrivateNetwork).user()).login;
			patch.tokenSealed = this.ctx.secrets.seal(row.orgId, parsed.token);
		}
		if (parsed.cloneToken === null) {
			patch.cloneTokenSealed = null;
			patch.cloneLogin = null;
		} else if (parsed.cloneToken) {
			patch.cloneLogin = (await this.clientFor(row.kind, row.baseUrl, parsed.cloneToken, row.allowPrivateNetwork).user()).login;
			patch.cloneTokenSealed = this.ctx.secrets.seal(row.orgId, parsed.cloneToken);
		}
		this.ctx.db.update(forgeConnections).set(patch).where(eq(forgeConnections.id, row.id)).run();
		this.forget(row.id);
		// A new token may have the permissions an earlier one lacked: retry what failed.
		if (parsed.token) await this.backfill(row.id);
		this.audit(principal, 'git.connection.update', row.id, {
			fields: Object.keys(parsed).filter((key) => parsed[key as keyof typeof parsed] !== undefined),
		});
		return this.view({ ...row, ...patch });
	}

	/** Forget the connection; hooks Yoal created on the forge are deleted (best effort). */
	async remove(principal: Principal, id: string): Promise<void> {
		this.requireManager(principal);
		const row = this.row(principal.orgId, id);
		const hooks = this.webhookRows(row.id);
		const client = this.client(row);
		for (const hook of hooks) {
			if (!hook.hookId) continue;
			await client.deleteHook(hook.scope, hook.path, hook.hookId).catch((error: Error) => {
				console.warn(`[forges] could not delete the ${hook.scope} hook on ${hook.path}: ${error.message}`);
			});
		}
		this.ctx.db.delete(forgeWebhooks).where(eq(forgeWebhooks.connectionId, row.id)).run();
		this.ctx.db.delete(forgeConnections).where(eq(forgeConnections.id, row.id)).run();
		this.forget(row.id);
		this.audit(principal, 'git.connection.remove', row.id, { kind: row.kind, baseUrl: row.baseUrl });
	}

	private forget(connectionId: string): void {
		for (const map of [this.repositoryCache, this.cloneCache, this.negative] as Array<Map<string, unknown>>)
			for (const key of map.keys()) if (key.startsWith(`${connectionId}:`)) map.delete(key);
	}

	// ---------------------------------------------------------------------------------- routing

	/** The org's connection serving a repository URL, and the repository's full name on it. */
	connectionFor(orgId: string, url: string): { row: ForgeConnectionRow; fullName: string } | null {
		let best: { row: ForgeConnectionRow; fullName: string; length: number } | null = null;
		for (const row of this.rows(orgId)) {
			const fullName = forgeFullName(row.baseUrl, url);
			const length = row.baseUrl.length;
			if (fullName && (!best || length > best.length)) best = { row, fullName, length };
		}
		return best ? { row: best.row, fullName: best.fullName } : null;
	}

	/** Whether a Yoal-created hook (repository or namespace) delivers this repository's events. */
	deliversFor(connectionId: string, fullName: string): boolean {
		const name = fullName.toLowerCase();
		return this.webhookRows(connectionId).some(
			(hook) =>
				hook.hookId !== null &&
				(hook.scope === 'repository' ? hook.path.toLowerCase() === name : name.startsWith(`${hook.path.toLowerCase()}/`)),
		);
	}

	/** Whether the repository sits under a namespace hook (so pushes may add it to Pipelines). */
	namespaceCovers(connectionId: string, fullName: string): boolean {
		const name = fullName.toLowerCase();
		return this.webhookRows(connectionId).some(
			(hook) => hook.hookId !== null && hook.scope === 'namespace' && name.startsWith(`${hook.path.toLowerCase()}/`),
		);
	}

	// ----------------------------------------------------------------------------- repositories

	private async connectionRepositories(row: ForgeConnectionRow, refresh: boolean): Promise<{ repositories: ForgeRepo[]; truncated: boolean }> {
		const key = `${row.id}:repos`;
		const cached = this.repositoryCache.get(key);
		if (cached && !refresh && cached.at + REPOSITORY_CACHE_MS > this.ctx.now()) return cached;
		const listed = await this.client(row).repositories(MAX_REPOSITORY_PAGES);
		const entry = { at: this.ctx.now(), ...listed };
		this.repositoryCache.set(key, entry);
		return entry;
	}

	/** Every connection's repositories for pickers. Errors are per connection, never thrown. */
	async repositories(
		orgId: string,
		options: { refresh?: boolean } = {},
	): Promise<{ repositories: GitRepositoryView[]; truncated: boolean; errors: Array<{ connectionId: string; kind: ForgeKind; name: string; error: string }> }> {
		const repositories: GitRepositoryView[] = [];
		const errors: Array<{ connectionId: string; kind: ForgeKind; name: string; error: string }> = [];
		let truncated = false;
		await Promise.all(
			this.rows(orgId).map(async (row) => {
				try {
					const listed = await this.connectionRepositories(row, options.refresh === true);
					truncated ||= listed.truncated;
					for (const repo of listed.repositories) repositories.push(this.repositoryView(row, repo));
				} catch (error) {
					errors.push({ connectionId: row.id, kind: row.kind, name: row.name, error: error instanceof Error ? error.message : String(error) });
				}
			}),
		);
		return { repositories, truncated, errors };
	}

	repositoryView(row: ForgeConnectionRow, repo: ForgeRepo): GitRepositoryView {
		const parsed = parseRepoUrl(repo.cloneUrl);
		return {
			provider: row.kind,
			connectionId: row.id,
			fullName: repo.fullName,
			owner: repo.owner,
			name: repo.name,
			private: repo.private,
			archived: repo.archived,
			defaultBranch: repo.defaultBranch,
			cloneUrl: repo.cloneUrl,
			htmlUrl: repo.htmlUrl,
			pushedAt: repo.pushedAt,
			key: parsed ? `${parsed.host}/${parsed.path}`.toLowerCase() : `${forgeBaseKey(row.baseUrl)}/${repo.fullName}`.toLowerCase(),
		};
	}

	async repository(orgId: string, connectionId: string, fullName: string): Promise<GitRepositoryView | null> {
		const row = this.row(orgId, connectionId);
		const repo = await this.client(row).repository(fullName);
		return repo ? this.repositoryView(row, repo) : null;
	}

	async readPath(orgId: string, connectionId: string, fullName: string, path: string, ref?: string): Promise<GithubPathContent | null> {
		return this.client(this.row(orgId, connectionId)).readPath(fullName, path, ref);
	}

	// ------------------------------------------------------------------------------------ clone

	/**
	 * Clone credentials for a repository URL (D175): a GitLab deploy token for that project when the
	 * API token may mint one, else the connection's clone token, else null. Only for https URLs on
	 * the connection's host; the credential is for that host alone. Never throws.
	 */
	async cloneAuth(orgId: string, url: string): Promise<ForgeCloneAuth | null> {
		const match = this.connectionFor(orgId, url);
		if (!match) return null;
		let host: string;
		try {
			const parsed = new URL(url);
			if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
			host = parsed.host.toLowerCase();
		} catch {
			return null;
		}
		const { row, fullName } = match;
		const key = `${row.id}:${fullName.toLowerCase()}`;
		const cached = this.cloneCache.get(key);
		if (cached && cached.expiresAt - CLONE_REUSE_MARGIN_MS > this.ctx.now())
			return { host, username: cached.username, token: cached.token };
		const until = this.negative.get(`${key}:clone`);
		if (!until || until <= this.ctx.now()) {
			try {
				const minted = await this.client(row).cloneCredential(fullName, this.ctx.now());
				if (minted) {
					this.cloneCache.set(key, minted);
					return { host, username: minted.username, token: minted.token };
				}
			} catch (error) {
				console.warn(`[forges] no deploy token for ${fullName}: ${(error as Error).message}`);
			}
			this.negative.set(`${key}:clone`, this.ctx.now() + NEGATIVE_CACHE_MS);
		}
		if (!row.cloneTokenSealed) return null;
		try {
			const token = this.ctx.secrets.open(row.orgId, row.cloneTokenSealed);
			return { host, username: row.kind === 'gitlab' ? 'oauth2' : (row.cloneLogin ?? 'yoal'), token };
		} catch {
			return null;
		}
	}

	// -------------------------------------------------------------------------------- reporting

	/** Best-effort commit status; false when no connection serves the URL or the forge refuses. */
	async commitStatus(orgId: string, url: string, report: ForgeStatusReport): Promise<boolean> {
		if (!/^[a-f0-9]{40}$/i.test(report.sha)) return false;
		const match = this.connectionFor(orgId, url);
		if (!match) return false;
		try {
			await this.client(match.row).commitStatus(match.fullName, report);
			return true;
		} catch (error) {
			console.warn(`[forges] commit status on ${match.fullName}@${report.sha.slice(0, 7)} failed: ${(error as Error).message}`);
			return false;
		}
	}

	/** Best-effort deployment (GitLab only). Returns the forge's id or null. */
	async deployment(orgId: string, url: string, input: ForgeDeploymentInput): Promise<string | null> {
		if (!/^[a-f0-9]{40}$/i.test(input.sha)) return null;
		const match = this.connectionFor(orgId, url);
		if (!match) return null;
		try {
			return await this.client(match.row).deployment(match.fullName, input);
		} catch (error) {
			console.warn(`[forges] deployment on ${match.fullName} failed: ${(error as Error).message}`);
			return null;
		}
	}

	// --------------------------------------------------------------------------------- webhooks

	private upsertHook(row: ForgeConnectionRow, scope: HookScope, path: string, patch: { hookId: string | null; error: string | null }): WebhookRow {
		const now = this.ctx.now();
		const existing = this.webhookRows(row.id).find((hook) => hook.scope === scope && hook.path.toLowerCase() === path.toLowerCase());
		if (existing) {
			this.ctx.db.update(forgeWebhooks).set({ ...patch, updatedAt: now }).where(eq(forgeWebhooks.id, existing.id)).run();
			return { ...existing, ...patch, updatedAt: now };
		}
		const created: WebhookRow = { id: newId('fgh_'), connectionId: row.id, orgId: row.orgId, scope, path, ...patch, createdAt: now, updatedAt: now };
		this.ctx.db.insert(forgeWebhooks).values(created).run();
		return created;
	}

	private async installHook(row: ForgeConnectionRow, scope: HookScope, path: string): Promise<WebhookRow> {
		const client = this.client(row);
		const url = this.webhookUrl(row.id);
		try {
			const secret = this.ctx.secrets.open(row.orgId, row.webhookSecretSealed);
			let hookId = await client.findHook(scope, path, url);
			// An existing hook with Yoal's URL may carry an old secret: replace it.
			if (hookId) await client.deleteHook(scope, path, hookId);
			hookId = await client.createHook(scope, path, url, secret);
			return this.upsertHook(row, scope, path, { hookId, error: null });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return this.upsertHook(row, scope, path, { hookId: null, error: message.slice(0, 500) });
		}
	}

	/**
	 * Make sure the forge delivers a repository's events (D174): when a connection serves `url` and
	 * no hook of Yoal's covers it, create a repository hook. Best effort: failures are recorded on
	 * the connection page, never thrown.
	 */
	async ensureWebhook(orgId: string, url: string): Promise<void> {
		const match = this.connectionFor(orgId, url);
		if (!match || this.deliversFor(match.row.id, match.fullName)) return;
		const result = await this.installHook(match.row, 'repository', match.fullName);
		if (result.error) console.warn(`[forges] webhook for ${match.fullName} not created: ${result.error}`);
	}

	/**
	 * Create the webhook for every repository the org already builds or runs pipelines for on this
	 * connection (enabled git sources and pipeline repositories) that no hook of Yoal's covers yet,
	 * including ones that failed before (D174). Called when a connection is added or its token
	 * replaced. Returns how many hooks were created; failures are recorded on the connection.
	 */
	async backfill(connectionId: string): Promise<number> {
		const row = this.ctx.db.select().from(forgeConnections).where(eq(forgeConnections.id, connectionId)).get();
		if (!row) return 0;
		const urls = [
			...this.ctx.db
				.select({ url: gitSources.repoUrl, deletedAt: projects.deletedAt })
				.from(gitSources)
				.innerJoin(projects, eq(projects.id, gitSources.projectId))
				.where(and(eq(gitSources.orgId, row.orgId), eq(gitSources.enabled, true)))
				.all()
				.filter((entry) => !entry.deletedAt)
				.map((entry) => entry.url),
			...this.ctx.db
				.select({ url: pipelineRepositories.cloneUrl })
				.from(pipelineRepositories)
				.where(and(eq(pipelineRepositories.orgId, row.orgId), eq(pipelineRepositories.enabled, true)))
				.all()
				.map((entry) => entry.url),
		];
		const names = new Map<string, string>();
		for (const url of urls) {
			const match = this.connectionFor(row.orgId, url);
			if (match?.row.id === row.id) names.set(match.fullName.toLowerCase(), match.fullName);
		}
		let created = 0;
		for (const fullName of names.values()) {
			if (this.deliversFor(row.id, fullName)) continue;
			const hook = await this.installHook(row, 'repository', fullName);
			if (hook.hookId) created++;
			else console.warn(`[forges] webhook for ${fullName} not created: ${hook.error}`);
		}
		return created;
	}

	/** How the org's connection serves a repository URL, for set-up hints (no network). */
	coverage(orgId: string, url: string): ForgeCoverage {
		const match = this.connectionFor(orgId, url);
		if (!match) return { status: 'no-connection', connectionId: null, connectionName: null, fullName: null, error: null };
		const failed = this.webhookRows(match.row.id).find(
			(hook) => hook.scope === 'repository' && hook.hookId === null && hook.path.toLowerCase() === match.fullName.toLowerCase(),
		);
		return {
			status: this.deliversFor(match.row.id, match.fullName) ? 'covered' : 'not-hooked',
			connectionId: match.row.id,
			connectionName: match.row.name,
			fullName: match.fullName,
			error: failed?.error ?? null,
		};
	}

	/** Create the hook for one repository URL now (the pipeline page's "Create the webhook"). */
	async hookRepository(principal: Principal, url: string): Promise<ForgeWebhookView> {
		const match = this.connectionFor(principal.orgId, url);
		if (!match) throw new ValidationError('No git provider connection serves that repository.');
		return this.addWebhook(principal, match.row.id, { repository: match.fullName });
	}

	/** Create (or re-create) a repository or namespace hook from the connection page. */
	async addWebhook(principal: Principal, id: string, input: ForgeWebhookCreate): Promise<ForgeWebhookView> {
		this.requireManager(principal);
		const row = this.row(principal.orgId, id);
		const parsed = forgeWebhookCreateSchema.parse(input);
		let scope: HookScope = 'namespace';
		let path = parsed.namespace?.replace(/^\/+|\/+$/g, '') ?? '';
		if (parsed.repository) {
			scope = 'repository';
			const fromUrl = /^(https?:\/\/|ssh:\/\/|[^@\s]+@)/.test(parsed.repository) ? forgeFullName(row.baseUrl, parsed.repository) : null;
			if (/^(https?:\/\/|ssh:\/\/|[^@\s]+@)/.test(parsed.repository) && !fromUrl)
				throw new ValidationError(`That URL is not on ${row.baseUrl}.`);
			path = fromUrl ?? parsed.repository.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
			if (!/^[A-Za-z0-9_.~-]+(?:\/[A-Za-z0-9_.~-]+)+$/.test(path)) throw new ValidationError('Use the repository’s full name, e.g. group/app.');
		} else if (!/^[A-Za-z0-9_.~-]+(?:\/[A-Za-z0-9_.~-]+)*$/.test(path)) throw new ValidationError('Use the group or organisation path, e.g. acme.');
		const hook = await this.installHook(row, scope, path);
		this.audit(principal, 'git.webhook.create', row.id, { scope, path, ok: !hook.error });
		return this.webhookView(hook);
	}

	async removeWebhook(principal: Principal, id: string, webhookId: string): Promise<void> {
		this.requireManager(principal);
		const row = this.row(principal.orgId, id);
		const hook = this.webhookRows(row.id).find((entry) => entry.id === webhookId);
		if (!hook) throw new NotFoundError('Webhook');
		if (hook.hookId)
			await this.client(row)
				.deleteHook(hook.scope, hook.path, hook.hookId)
				.catch((error: Error) => console.warn(`[forges] could not delete hook ${hook.hookId}: ${error.message}`));
		this.ctx.db.delete(forgeWebhooks).where(eq(forgeWebhooks.id, hook.id)).run();
		this.audit(principal, 'git.webhook.remove', row.id, { scope: hook.scope, path: hook.path });
	}

	/**
	 * A connection's receiver (`/api/webhooks/forge/<id>`). Verified with the connection's secret
	 * (GitLab token or Gitea/Forgejo signature), normalised, then routed by repository to the org's
	 * git builds and pipelines.
	 */
	async handleWebhook(connectionId: string, rawBody: string, headers: HeaderReader): Promise<ForgeWebhookResult> {
		const row = this.ctx.db.select().from(forgeConnections).where(eq(forgeConnections.id, connectionId)).get();
		if (!row) throw new NotFoundError('Git provider connection');
		const source = webhookSource(headers) ?? row.kind;
		const compatible = row.kind === 'gitlab' ? source === 'gitlab' : source === 'gitea' || source === 'forgejo';
		const secret = this.ctx.secrets.open(row.orgId, row.webhookSecretSealed);
		if (!compatible || !verifyDelivery(source, secret, rawBody, headers))
			throw new CoreError('unauthorized', 'Invalid webhook signature.', 401);
		let payload: unknown;
		try {
			payload = JSON.parse(rawBody);
		} catch {
			throw new ValidationError(`${FORGE_LABELS[row.kind]} payload is not valid JSON.`);
		}
		const event = normaliseForgeEvent(source, webhookEventName(source, headers), payload);
		if (event.kind === 'ping') return { accepted: true, reason: 'pong' };
		if (event.kind === 'ignored') return { accepted: false, reason: event.reason };
		if (!event.fullName) return { accepted: false, reason: 'no repository in the payload' };
		const identity = `forge:${row.id}:${event.fullName.toLowerCase()}`;
		const result: ForgeWebhookResult = { accepted: false, builds: [], triggers: [] };
		if (event.kind === 'push') result.builds = await this.ctx.builds.handlePush(row.orgId, identity, event);
		result.triggers = await this.ctx.pipelines.handleForgeEvent(row.orgId, identity, event, {
			connectionId: row.id,
			fullName: event.fullName,
			createdBy: row.createdBy,
			mayAutoRegister: this.namespaceCovers(row.id, event.fullName),
		});
		result.accepted = (result.builds?.length ?? 0) + (result.triggers?.length ?? 0) > 0;
		if (!result.accepted) result.reason = `nothing in this organisation builds ${event.fullName} for this event`;
		return result;
	}

	private audit(principal: Principal, action: string, resourceId: string, args: Record<string, unknown>): void {
		this.ctx.audit.record({ principal, action, resource: 'build', resourceId, args, result: 'ok' });
	}
}

/** Org managers (`org:update`); connections hold org-wide forge tokens (D173). */
function isOrgManager(principal: Principal): boolean {
	return principal.permissions.has('org:update');
}
