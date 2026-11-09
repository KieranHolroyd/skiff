import type { ForgeKind } from '@yoal/contracts';
import { CoreError } from '../errors.ts';
import type { GithubPathContent } from '../github-app.ts';

/**
 * REST clients for GitLab (API v4) and Gitea/Forgejo (API v1), driven by a connection's token
 * (docs/FORGES.md). Each client knows only its forge's paths and shapes; `ForgeService` decides
 * when to call them.
 */

const REQUEST_TIMEOUT_MS = 15_000;
const PAGE_SIZE_GITLAB = 100;
const PAGE_SIZE_GITEA = 50;

export type ForgeStatusState = 'pending' | 'running' | 'success' | 'failure' | 'error';

export interface ForgeStatusReport {
	sha: string;
	state: ForgeStatusState;
	context: string;
	description: string;
	targetUrl: string;
}

export interface ForgeDeploymentInput {
	sha: string;
	ref: string;
	environment: string;
	environmentUrl: string;
	production: boolean;
}

export interface ForgeRepo {
	id: string;
	fullName: string;
	owner: string;
	name: string;
	private: boolean;
	archived: boolean;
	defaultBranch: string;
	cloneUrl: string;
	htmlUrl: string;
	pushedAt: string | null;
}

export interface ForgeCloneCredential {
	username: string;
	token: string;
	/** Milliseconds since the epoch. */
	expiresAt: number;
}

export type HookScope = 'repository' | 'namespace';

export interface ForgeClient {
	readonly kind: ForgeKind;
	/** The token's account (proves the token). */
	user(): Promise<{ login: string }>;
	repositories(maxPages: number): Promise<{ repositories: ForgeRepo[]; truncated: boolean }>;
	repository(fullName: string): Promise<ForgeRepo | null>;
	/** A directory listing or a file's text; null when the path (or ref) does not exist. */
	readPath(fullName: string, path: string, ref?: string): Promise<GithubPathContent | null>;
	commitStatus(fullName: string, report: ForgeStatusReport): Promise<void>;
	/** Records a deployment; null when the forge has no deployments API. */
	deployment(fullName: string, input: ForgeDeploymentInput): Promise<string | null>;
	findHook(scope: HookScope, path: string, url: string): Promise<string | null>;
	createHook(scope: HookScope, path: string, url: string, secret: string): Promise<string>;
	deleteHook(scope: HookScope, path: string, hookId: string): Promise<void>;
	/** A read-only credential for one repository, when the forge can mint one (GitLab deploy tokens). */
	cloneCredential(fullName: string, now: number): Promise<ForgeCloneCredential | null>;
}

export interface ForgeClientOptions {
	kind: ForgeKind;
	baseUrl: string;
	token: string;
	fetch?: typeof fetch;
}

export function forgeClient(options: ForgeClientOptions): ForgeClient {
	return options.kind === 'gitlab' ? new GitlabClient(options) : new GiteaClient(options);
}

const enc = encodeURIComponent;

class ForgeHttp {
	constructor(
		private readonly label: string,
		private readonly apiBase: string,
		private readonly headers: Record<string, string>,
		private readonly fetcher: typeof fetch,
	) {}

	async request<T>(
		method: 'GET' | 'POST' | 'PUT' | 'DELETE',
		path: string,
		body?: unknown,
		options: { allowNotFound?: boolean } = {},
	): Promise<{ data: T | null; headers: Headers }> {
		let response: Response;
		try {
			response = await this.fetcher(`${this.apiBase}${path}`, {
				method,
				headers: {
					accept: 'application/json',
					'user-agent': 'yoal',
					...this.headers,
					...(body === undefined ? {} : { 'content-type': 'application/json' }),
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
		} catch (error) {
			throw new CoreError('forge_unreachable', `${this.label} could not be reached: ${error instanceof Error ? error.message : String(error)}`, 502);
		}
		if (response.status === 404 && options.allowNotFound) return { data: null, headers: response.headers };
		if (!response.ok) {
			let detail = '';
			try {
				const payload = (await response.json()) as { message?: unknown; error?: unknown };
				const message = payload.message ?? payload.error;
				detail = typeof message === 'string' ? message : message ? JSON.stringify(message) : '';
			} catch {
				// Non-JSON error body.
			}
			const reason = (detail || `HTTP ${response.status}`).slice(0, 300);
			throw new CoreError(
				response.status === 401 ? 'forge_unauthorized' : response.status === 403 ? 'forge_forbidden' : 'forge_error',
				response.status === 401
					? `${this.label} rejected the token (${reason}).`
					: response.status === 403
						? `${this.label} refused: the token lacks a permission (${reason}).`
						: `${this.label} returned an error (${reason}).`,
				response.status === 401 || response.status === 403 ? 409 : 502,
			);
		}
		if (response.status === 204) return { data: null, headers: response.headers };
		const text = await response.text();
		return { data: text ? (JSON.parse(text) as T) : null, headers: response.headers };
	}
}

function decodeBase64(content: unknown, encoding: unknown): string | null {
	if (typeof content !== 'string') return null;
	if (encoding && encoding !== 'base64') return content;
	return Buffer.from(content, 'base64').toString('utf8');
}

function cleanPath(path: string): string {
	return path.replace(/^\.?\/+/, '').replace(/\/+$/, '').replace(/^\.$/, '');
}

// ---------------------------------------------------------------------------------------- GitLab

interface GitlabProject {
	id: number;
	name: string;
	path_with_namespace: string;
	namespace?: { full_path?: string } | null;
	visibility?: string;
	archived?: boolean;
	default_branch?: string | null;
	http_url_to_repo: string;
	web_url: string;
	last_activity_at?: string | null;
}

/** Yoal state → GitLab commit status state. */
export function gitlabState(state: ForgeStatusState): string {
	switch (state) {
		case 'running':
			return 'running';
		case 'success':
			return 'success';
		case 'failure':
			return 'failed';
		case 'error':
			return 'canceled';
		default:
			return 'pending';
	}
}

const DEPLOY_TOKEN_NAME = 'yoal-clone';
const DEPLOY_TOKEN_LIFETIME_MS = 2 * 24 * 60 * 60_000;

class GitlabClient implements ForgeClient {
	readonly kind = 'gitlab' as const;
	private readonly http: ForgeHttp;

	constructor(options: ForgeClientOptions) {
		this.http = new ForgeHttp('GitLab', `${options.baseUrl.replace(/\/+$/, '')}/api/v4`, { 'private-token': options.token }, options.fetch ?? fetch);
	}

	private project(fullName: string): string {
		return `/projects/${enc(fullName)}`;
	}

	private view(project: GitlabProject): ForgeRepo {
		const namespace = project.namespace?.full_path ?? project.path_with_namespace.split('/').slice(0, -1).join('/');
		return {
			id: String(project.id),
			fullName: project.path_with_namespace,
			owner: namespace,
			name: project.path_with_namespace.split('/').pop() ?? project.name,
			private: project.visibility !== 'public',
			archived: project.archived ?? false,
			defaultBranch: project.default_branch ?? 'main',
			cloneUrl: project.http_url_to_repo,
			htmlUrl: project.web_url,
			pushedAt: project.last_activity_at ?? null,
		};
	}

	async user(): Promise<{ login: string }> {
		const { data } = await this.http.request<{ username?: string }>('GET', '/user');
		if (!data?.username) throw new CoreError('forge_error', 'GitLab did not say who the token belongs to.', 502);
		return { login: data.username };
	}

	async repositories(maxPages: number): Promise<{ repositories: ForgeRepo[]; truncated: boolean }> {
		const repositories: ForgeRepo[] = [];
		let truncated = false;
		for (let page = 1; page <= maxPages; page++) {
			const { data, headers } = await this.http.request<GitlabProject[]>(
				'GET',
				`/projects?membership=true&min_access_level=30&archived=false&order_by=last_activity_at&per_page=${PAGE_SIZE_GITLAB}&page=${page}`,
			);
			for (const project of data ?? []) repositories.push(this.view(project));
			const next = headers.get('x-next-page');
			if (!data || data.length < PAGE_SIZE_GITLAB || next === '') break;
			if (page === maxPages) truncated = true;
		}
		return { repositories, truncated };
	}

	async repository(fullName: string): Promise<ForgeRepo | null> {
		const { data } = await this.http.request<GitlabProject>('GET', this.project(fullName), undefined, { allowNotFound: true });
		return data ? this.view(data) : null;
	}

	async readPath(fullName: string, path: string, ref?: string): Promise<GithubPathContent | null> {
		const clean = cleanPath(path);
		const refQuery = ref ? `&ref=${enc(ref)}` : '';
		const tree = await this.http.request<Array<{ name: string; path: string; type: string }>>(
			'GET',
			`${this.project(fullName)}/repository/tree?per_page=100${clean ? `&path=${enc(clean)}` : ''}${refQuery}`,
			undefined,
			{ allowNotFound: true },
		);
		if (tree.data && tree.data.length > 0)
			return { kind: 'dir', entries: tree.data.map((entry) => ({ name: entry.name, path: entry.path, type: entry.type === 'tree' ? 'dir' : 'file' })) };
		if (!clean) return null;
		const file = await this.http.request<{ content?: string; encoding?: string }>(
			'GET',
			`${this.project(fullName)}/repository/files/${enc(clean)}?ref=${enc(ref ?? 'HEAD')}`,
			undefined,
			{ allowNotFound: true },
		);
		if (!file.data) return null;
		return { kind: 'file', text: decodeBase64(file.data.content, file.data.encoding) };
	}

	async commitStatus(fullName: string, report: ForgeStatusReport): Promise<void> {
		try {
			await this.http.request('POST', `${this.project(fullName)}/statuses/${report.sha}`, {
				state: gitlabState(report.state),
				name: report.context.slice(0, 255),
				description: report.description.slice(0, 255),
				target_url: report.targetUrl,
			});
		} catch (error) {
			// GitLab refuses a transition to the state a status is already in; that is not a failure.
			if (error instanceof CoreError && /transition/i.test(error.message)) return;
			throw error;
		}
	}

	async deployment(fullName: string, input: ForgeDeploymentInput): Promise<string | null> {
		const { data } = await this.http.request<{ id?: number }>('POST', `${this.project(fullName)}/deployments`, {
			environment: input.environment,
			sha: input.sha,
			ref: input.ref,
			tag: false,
			status: 'success',
		});
		return data?.id ? String(data.id) : null;
	}

	private hooksPath(scope: HookScope, path: string): string {
		return scope === 'namespace' ? `/groups/${enc(path)}/hooks` : `${this.project(path)}/hooks`;
	}

	async findHook(scope: HookScope, path: string, url: string): Promise<string | null> {
		const { data } = await this.http.request<Array<{ id: number; url: string }>>('GET', `${this.hooksPath(scope, path)}?per_page=100`);
		const found = (data ?? []).find((hook) => hook.url === url);
		return found ? String(found.id) : null;
	}

	async createHook(scope: HookScope, path: string, url: string, secret: string): Promise<string> {
		const { data } = await this.http.request<{ id?: number }>('POST', this.hooksPath(scope, path), {
			url,
			token: secret,
			push_events: true,
			tag_push_events: true,
			merge_requests_events: true,
			enable_ssl_verification: url.startsWith('https://'),
		});
		if (!data?.id) throw new CoreError('forge_error', 'GitLab did not return the new webhook.', 502);
		return String(data.id);
	}

	async deleteHook(scope: HookScope, path: string, hookId: string): Promise<void> {
		await this.http.request('DELETE', `${this.hooksPath(scope, path)}/${enc(hookId)}`, undefined, { allowNotFound: true });
	}

	/**
	 * A per-project deploy token with `read_repository`, valid two days (D175). Needs Maintainer;
	 * returns null on a refusal. Expired Yoal tokens on the project are revoked first.
	 */
	async cloneCredential(fullName: string, now: number): Promise<ForgeCloneCredential | null> {
		const base = `${this.project(fullName)}/deploy_tokens`;
		try {
			const { data: existing } = await this.http.request<Array<{ id: number; name: string; expires_at?: string | null; expired?: boolean; revoked?: boolean }>>(
				'GET',
				`${base}?per_page=100`,
			);
			for (const token of existing ?? []) {
				if (token.name !== DEPLOY_TOKEN_NAME || token.revoked) continue;
				const expiry = token.expires_at ? Date.parse(token.expires_at) : Number.NaN;
				if (token.expired || (Number.isFinite(expiry) && expiry < now))
					await this.http.request('DELETE', `${base}/${token.id}`, undefined, { allowNotFound: true }).catch(() => undefined);
			}
			const expiresAt = now + DEPLOY_TOKEN_LIFETIME_MS;
			const { data } = await this.http.request<{ username?: string; token?: string }>('POST', base, {
				name: DEPLOY_TOKEN_NAME,
				scopes: ['read_repository'],
				expires_at: new Date(expiresAt).toISOString(),
			});
			if (!data?.username || !data.token) return null;
			return { username: data.username, token: data.token, expiresAt };
		} catch (error) {
			if (error instanceof CoreError && (error.code === 'forge_forbidden' || error.code === 'forge_unauthorized' || error.code === 'forge_error'))
				return null;
			throw error;
		}
	}
}

// --------------------------------------------------------------------------------- Gitea/Forgejo

interface GiteaRepo {
	id: number;
	name: string;
	full_name: string;
	owner?: { login?: string; username?: string } | null;
	private?: boolean;
	archived?: boolean;
	default_branch?: string;
	clone_url: string;
	html_url: string;
	updated_at?: string | null;
}

interface GiteaContent {
	name: string;
	path: string;
	type: string;
	content?: string | null;
	encoding?: string | null;
}

class GiteaClient implements ForgeClient {
	readonly kind: ForgeKind;
	private readonly http: ForgeHttp;

	constructor(options: ForgeClientOptions) {
		this.kind = options.kind;
		const label = options.kind === 'forgejo' ? 'Forgejo' : 'Gitea';
		this.http = new ForgeHttp(label, `${options.baseUrl.replace(/\/+$/, '')}/api/v1`, { authorization: `token ${options.token}` }, options.fetch ?? fetch);
	}

	private repo(fullName: string): string {
		const [owner = '', ...rest] = fullName.split('/');
		return `/repos/${enc(owner)}/${enc(rest.join('/'))}`;
	}

	private view(repo: GiteaRepo): ForgeRepo {
		return {
			id: String(repo.id),
			fullName: repo.full_name,
			owner: repo.owner?.login ?? repo.owner?.username ?? repo.full_name.split('/')[0] ?? '',
			name: repo.name,
			private: repo.private ?? false,
			archived: repo.archived ?? false,
			defaultBranch: repo.default_branch || 'main',
			cloneUrl: repo.clone_url,
			htmlUrl: repo.html_url,
			pushedAt: repo.updated_at ?? null,
		};
	}

	async user(): Promise<{ login: string }> {
		const { data } = await this.http.request<{ login?: string; username?: string }>('GET', '/user');
		const login = data?.login ?? data?.username;
		if (!login) throw new CoreError('forge_error', 'The forge did not say who the token belongs to.', 502);
		return { login };
	}

	async repositories(maxPages: number): Promise<{ repositories: ForgeRepo[]; truncated: boolean }> {
		const repositories: ForgeRepo[] = [];
		let truncated = false;
		for (let page = 1; page <= maxPages; page++) {
			const { data } = await this.http.request<GiteaRepo[]>('GET', `/user/repos?limit=${PAGE_SIZE_GITEA}&page=${page}`);
			for (const repo of data ?? []) if (!repo.archived) repositories.push(this.view(repo));
			if (!data || data.length < PAGE_SIZE_GITEA) break;
			if (page === maxPages) truncated = true;
		}
		repositories.sort((a, b) => (b.pushedAt ?? '').localeCompare(a.pushedAt ?? ''));
		return { repositories, truncated };
	}

	async repository(fullName: string): Promise<ForgeRepo | null> {
		const { data } = await this.http.request<GiteaRepo>('GET', this.repo(fullName), undefined, { allowNotFound: true });
		return data ? this.view(data) : null;
	}

	async readPath(fullName: string, path: string, ref?: string): Promise<GithubPathContent | null> {
		const clean = cleanPath(path);
		const encoded = clean ? `/${clean.split('/').map(enc).join('/')}` : '';
		const { data } = await this.http.request<GiteaContent | GiteaContent[]>(
			'GET',
			`${this.repo(fullName)}/contents${encoded}${ref ? `?ref=${enc(ref)}` : ''}`,
			undefined,
			{ allowNotFound: true },
		);
		if (!data) return null;
		if (Array.isArray(data))
			return { kind: 'dir', entries: data.map((entry) => ({ name: entry.name, path: entry.path, type: entry.type === 'dir' ? 'dir' : 'file' })) };
		if (data.type !== 'file') return null;
		return { kind: 'file', text: decodeBase64(data.content, data.encoding) };
	}

	async commitStatus(fullName: string, report: ForgeStatusReport): Promise<void> {
		await this.http.request('POST', `${this.repo(fullName)}/statuses/${report.sha}`, {
			state: report.state === 'running' ? 'pending' : report.state,
			context: report.context.slice(0, 255),
			description: report.description.slice(0, 255),
			target_url: report.targetUrl,
		});
	}

	async deployment(): Promise<string | null> {
		return null;
	}

	private hooksPath(scope: HookScope, path: string): string {
		return scope === 'namespace' ? `/orgs/${enc(path)}/hooks` : `${this.repo(path)}/hooks`;
	}

	async findHook(scope: HookScope, path: string, url: string): Promise<string | null> {
		const { data } = await this.http.request<Array<{ id: number; config?: { url?: string } }>>('GET', `${this.hooksPath(scope, path)}?limit=50`);
		const found = (data ?? []).find((hook) => hook.config?.url === url);
		return found ? String(found.id) : null;
	}

	async createHook(scope: HookScope, path: string, url: string, secret: string): Promise<string> {
		const { data } = await this.http.request<{ id?: number }>('POST', this.hooksPath(scope, path), {
			type: 'gitea',
			config: { url, content_type: 'json', secret },
			events: ['push', 'pull_request', 'pull_request_sync'],
			active: true,
		});
		if (!data?.id) throw new CoreError('forge_error', 'The forge did not return the new webhook.', 502);
		return String(data.id);
	}

	async deleteHook(scope: HookScope, path: string, hookId: string): Promise<void> {
		await this.http.request('DELETE', `${this.hooksPath(scope, path)}/${enc(hookId)}`, undefined, { allowNotFound: true });
	}

	async cloneCredential(): Promise<ForgeCloneCredential | null> {
		return null;
	}
}
