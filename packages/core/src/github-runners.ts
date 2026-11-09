import { createSign } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { githubRunnerRegistrations, projects, workloads } from '@yoal/db';
import {
	GITHUB_RUNNER_JITCONFIG_ENV,
	githubRunnerLabels,
	githubRunnerTarget,
	workloadSpecSchema,
	type GithubRunner,
	type GithubRunnerPoolView,
	type GithubRunnerView,
	type Principal,
	type WorkloadSpec,
} from '@yoal/contracts';
import type { CoreContext } from './context.ts';
import { CoreError } from './errors.ts';
import { newId, parseJson } from './util.ts';
import type { ProjectRow } from './projects.ts';

const GITHUB_API = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';
/** Refresh an installation token this long before GitHub expires it (tokens live one hour). */
const APP_TOKEN_REFRESH_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

interface CachedToken {
	token: string;
	expiresAt: number;
}

interface GithubRunnerApi {
	id: number;
	name: string;
	status: string;
	busy: boolean;
	labels?: Array<{ name: string }>;
}

/** Context a JIT mint needs; the workload row supplies org/project/replica identity. */
export interface RunnerMintTarget {
	orgId: string;
	projectId: string;
	projectSlug: string;
	workloadId: string;
	replica: number;
	runner: GithubRunner;
}

/**
 * GitHub Actions runner registration (plan 21, D91–D93).
 *
 * The control plane is the only component that holds the GitHub credential. For every replica
 * start it mints a single-use JIT config (`generate-jitconfig`), hands it to the node through the
 * activation endpoint, and records the registration so the replica's previous runner can be
 * removed. The credential is a PAT or a GitHub App installation token minted from the App's
 * private key; both are read from the secret store on demand and never written anywhere else.
 */
export class GithubRunnerService {
	private readonly appTokens = new Map<string, CachedToken>();

	constructor(private readonly ctx: CoreContext) {}

	private get fetcher(): typeof fetch {
		return this.ctx.config.githubFetch ?? fetch;
	}

	/** Mint a fresh JIT config for one replica and return the env the container needs. */
	async mintJitConfig(target: RunnerMintTarget): Promise<Record<string, string>> {
		const { runner } = target;
		const token = await this.accessToken(target.orgId, target.projectId, runner);
		await this.removePrevious(target, token);
		const name = runnerName(target.projectSlug, target.replica);
		const response = await this.request<{ runner: GithubRunnerApi; encoded_jit_config: string }>(
			token,
			'POST',
			`${basePath(runner)}/actions/runners/generate-jitconfig`,
			{
				name,
				runner_group_id: runner.scope === 'org' ? runner.runnerGroupId : 1,
				labels: githubRunnerLabels(runner),
				work_folder: '_work',
			},
		);
		if (!response?.encoded_jit_config || typeof response.runner?.id !== 'number')
			throw new CoreError('github_error', 'GitHub returned no JIT config for the runner.', 502);
		this.ctx.db
			.insert(githubRunnerRegistrations)
			.values({
				id: newId('ghr_'),
				orgId: target.orgId,
				projectId: target.projectId,
				workloadId: target.workloadId,
				replica: target.replica,
				runnerId: response.runner.id,
				runnerName: name,
				target: githubRunnerTarget(runner),
				createdAt: this.ctx.now(),
			})
			.run();
		return { [GITHUB_RUNNER_JITCONFIG_ENV]: response.encoded_jit_config };
	}

	/**
	 * The pool as GitHub sees it: our registrations matched to GitHub's runner list. Read-only and
	 * best effort; a GitHub failure is returned as `error`, never thrown at the dashboard.
	 */
	async pool(principal: Principal, project: ProjectRow, spec: WorkloadSpec): Promise<GithubRunnerPoolView | null> {
		this.ctx.iam.require(principal, 'deployment:read', { type: 'project', id: project.id });
		const runner = spec.runner;
		if (!runner) return null;
		const view: GithubRunnerPoolView = {
			target: githubRunnerTarget(runner),
			scope: runner.scope,
			replicas: spec.replicas,
			labels: githubRunnerLabels(runner),
			auth: runner.auth.method,
			runners: [],
			error: null,
		};
		const registrations = this.ctx.db
			.select()
			.from(githubRunnerRegistrations)
			.where(eq(githubRunnerRegistrations.projectId, project.id))
			.all();
		const latest = new Map<number, (typeof registrations)[number]>();
		for (const row of registrations) {
			const current = latest.get(row.replica);
			if (!current || current.createdAt < row.createdAt) latest.set(row.replica, row);
		}
		let remote: GithubRunnerApi[] = [];
		try {
			const token = await this.accessToken(project.orgId, project.id, runner);
			const listed = await this.request<{ runners: GithubRunnerApi[] }>(
				token,
				'GET',
				`${basePath(runner)}/actions/runners?per_page=100`,
			);
			remote = listed?.runners ?? [];
		} catch (error) {
			view.error = error instanceof Error ? error.message : String(error);
		}
		const byId = new Map(remote.map((entry) => [entry.id, entry]));
		view.runners = [...latest.values()]
			.filter((row) => row.replica < spec.replicas)
			.sort((a, b) => a.replica - b.replica)
			.map((row): GithubRunnerView => {
				const found = byId.get(row.runnerId);
				return {
					id: found ? row.runnerId : null,
					name: row.runnerName,
					replica: row.replica,
					status: found ? (found.status === 'online' ? 'online' : 'offline') : view.error ? 'unknown' : 'offline',
					busy: found?.busy ?? false,
					labels: found?.labels?.map((label) => label.name) ?? githubRunnerLabels(runner),
					registeredAt: new Date(row.createdAt).toISOString(),
				};
			});
		return view;
	}

	/**
	 * Remove every registration the project still has (project delete, runner removed from the
	 * spec). Best effort: GitHub also garbage-collects offline ephemeral runners on its own.
	 */
	async deregisterProject(project: Pick<ProjectRow, 'id' | 'orgId'>, runner: GithubRunner | undefined): Promise<void> {
		const rows = this.ctx.db
			.select()
			.from(githubRunnerRegistrations)
			.where(eq(githubRunnerRegistrations.projectId, project.id))
			.all();
		if (rows.length === 0) return;
		if (runner) {
			try {
				const token = await this.accessToken(project.orgId, project.id, runner);
				for (const row of rows) await this.deleteRunner(token, runner, row.runnerId);
			} catch {
				// Credential gone or GitHub unreachable: GitHub removes offline ephemeral runners itself.
			}
		}
		this.ctx.db.delete(githubRunnerRegistrations).where(eq(githubRunnerRegistrations.projectId, project.id)).run();
	}

	/**
	 * Prune support: remove one registration row, best-effort deleting the runner on GitHub when
	 * its workload still carries a runner profile. Returns false when the row is already gone.
	 */
	async deregisterRegistration(rowId: string): Promise<boolean> {
		const row = this.ctx.db.select().from(githubRunnerRegistrations).where(eq(githubRunnerRegistrations.id, rowId)).get();
		if (!row) return false;
		const workload = this.ctx.db.select({ specJson: workloads.specJson }).from(workloads).where(eq(workloads.id, row.workloadId)).get();
		const project = this.ctx.db
			.select({ id: projects.id, deletedAt: projects.deletedAt })
			.from(projects)
			.where(eq(projects.id, row.projectId))
			.get();
		const runner = workload ? workloadSpecSchema.safeParse(parseJson<unknown>(workload.specJson, null)).data?.runner : undefined;
		if (runner && project && !project.deletedAt) {
			try {
				const token = await this.accessToken(row.orgId, row.projectId, runner);
				await this.deleteRunner(token, runner, row.runnerId);
			} catch {
				// Credential gone or GitHub unreachable: GitHub removes offline ephemeral runners itself.
			}
		}
		this.ctx.db.delete(githubRunnerRegistrations).where(eq(githubRunnerRegistrations.id, rowId)).run();
		return true;
	}

	/** Record a GitHub failure on the workload row so the dashboard can say why runners are down. */
	noteFailure(workloadId: string, message: string | null): void {
		this.ctx.db
			.update(workloads)
			.set({ message, updatedAt: this.ctx.now() })
			.where(eq(workloads.id, workloadId))
			.run();
	}

	/** A replica only asks for a new JIT config after its previous runner exited; clean it up. */
	private async removePrevious(target: RunnerMintTarget, token: string): Promise<void> {
		const previous = this.ctx.db
			.select()
			.from(githubRunnerRegistrations)
			.where(
				and(
					eq(githubRunnerRegistrations.workloadId, target.workloadId),
					eq(githubRunnerRegistrations.replica, target.replica),
				),
			)
			.all();
		for (const row of previous) {
			try {
				await this.deleteRunner(token, target.runner, row.runnerId);
			} catch {
				// A busy or vanished runner is not a reason to keep the replica down.
			}
			this.ctx.db.delete(githubRunnerRegistrations).where(eq(githubRunnerRegistrations.id, row.id)).run();
		}
	}

	private async deleteRunner(token: string, runner: GithubRunner, runnerId: number): Promise<void> {
		await this.request(token, 'DELETE', `${basePath(runner)}/actions/runners/${runnerId}`, undefined, [404]);
	}

	/** A PAT from the secret store, a cached App installation token, or Yoal's own App (D165). */
	private async accessToken(orgId: string, projectId: string, runner: GithubRunner): Promise<string> {
		if (runner.auth.method === 'installation') {
			return this.ctx.githubApp.ownerToken(orgId, runner.owner, {
				...(runner.scope === 'repo' && runner.repo ? { repo: runner.repo } : {}),
				permissions: runner.scope === 'repo' ? { administration: 'write' } : { organization_self_hosted_runners: 'write' },
			});
		}
		if (runner.auth.method === 'pat') {
			const secret = this.ctx.secrets.getValue(orgId, runner.auth.tokenSecret, undefined, projectId);
			if (!secret) throw new CoreError('github_credential_missing', `Secret ${runner.auth.tokenSecret} does not exist.`, 409);
			return secret.value.trim();
		}
		const { appId, installationId, privateKeySecret } = runner.auth;
		const cacheKey = `${orgId}:${projectId}:${appId}:${installationId}`;
		const cached = this.appTokens.get(cacheKey);
		if (cached && cached.expiresAt - APP_TOKEN_REFRESH_MS > this.ctx.now()) return cached.token;
		const secret = this.ctx.secrets.getValue(orgId, privateKeySecret, undefined, projectId);
		if (!secret) throw new CoreError('github_credential_missing', `Secret ${privateKeySecret} does not exist.`, 409);
		const jwt = githubAppJwt(appId, secret.value, this.ctx.now());
		const issued = await this.request<{ token: string; expires_at: string }>(
			jwt,
			'POST',
			`/app/installations/${installationId}/access_tokens`,
		);
		if (!issued?.token) throw new CoreError('github_error', 'GitHub did not issue an installation token.', 502);
		const expiresAt = Date.parse(issued.expires_at);
		this.appTokens.set(cacheKey, {
			token: issued.token,
			expiresAt: Number.isFinite(expiresAt) ? expiresAt : this.ctx.now() + 60 * 60_000,
		});
		return issued.token;
	}

	private async request<T>(
		token: string,
		method: 'GET' | 'POST' | 'DELETE',
		path: string,
		body?: unknown,
		okStatuses: number[] = [],
	): Promise<T | null> {
		let response: Response;
		try {
			response = await this.fetcher(`${GITHUB_API}${path}`, {
				method,
				headers: {
					accept: 'application/vnd.github+json',
					authorization: `Bearer ${token}`,
					'x-github-api-version': GITHUB_API_VERSION,
					'user-agent': 'yoal-runner-controller',
					...(body === undefined ? {} : { 'content-type': 'application/json' }),
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
		} catch (error) {
			throw new CoreError('github_unreachable', `GitHub could not be reached: ${error instanceof Error ? error.message : String(error)}`, 502);
		}
		if (okStatuses.includes(response.status)) return null;
		if (!response.ok) {
			let detail = '';
			try {
				const payload = (await response.json()) as { message?: unknown };
				if (typeof payload.message === 'string') detail = payload.message;
			} catch {
				// Non-JSON error body.
			}
			throw new CoreError('github_error', githubErrorMessage(response.status, detail), 502);
		}
		if (response.status === 204) return null;
		return (await response.json()) as T;
	}
}

function basePath(runner: GithubRunner): string {
	return runner.scope === 'repo'
		? `/repos/${encodeURIComponent(runner.owner)}/${encodeURIComponent(runner.repo ?? '')}`
		: `/orgs/${encodeURIComponent(runner.owner)}`;
}

/** `yoal-<slug>-<replica>-<random>`; unique so a replica's next runner never clashes with the last. */
export function runnerName(slug: string, replica: number): string {
	const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 6);
	return `yoal-${slug}-${replica}-${suffix}`;
}

function githubErrorMessage(status: number, detail: string): string {
	const reason = detail || `HTTP ${status}`;
	if (status === 401) return `GitHub rejected the credential (${reason}).`;
	if (status === 403 || status === 404)
		return `GitHub refused the runner request (${reason}). Check the repository or organisation name and that the token or app has permission to manage self-hosted runners.`;
	return `GitHub returned an error (${reason}).`;
}

function base64url(input: string | Buffer): string {
	return Buffer.from(input).toString('base64url');
}

/** RS256 app JWT, valid for nine minutes with a minute of clock-skew allowance (GitHub caps at ten). */
export function githubAppJwt(appId: number, privateKeyPem: string, nowMs: number): string {
	const now = Math.floor(nowMs / 1000);
	const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
	const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: String(appId) }));
	const signer = createSign('RSA-SHA256');
	signer.update(`${header}.${payload}`);
	signer.end();
	let signature: string;
	try {
		signature = signer.sign(privateKeyPem, 'base64url');
	} catch {
		throw new CoreError('github_credential_invalid', 'The GitHub App private key could not be read. Paste the PEM file GitHub generated.', 409);
	}
	return `${header}.${payload}.${signature}`;
}
