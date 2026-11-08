import {
	FORGE_LABELS,
	forgeBaseKey,
	githubRepoKey,
	parseGithubRepoUrl,
	repoKey,
	type GitProviderKind,
	type GitProviderLink,
	type GitRepositoryList,
	type GitRepositoryView,
	type Principal,
} from '@skiff/contracts';
import type { CoreContext } from '../context.ts';
import type { GithubPathContent } from '../github-app.ts';
import type { ForgeStatusReport } from './clients.ts';
import type { ForgeCloneAuth } from './service.ts';

/**
 * One door to every git provider (docs/FORGES.md §5): builds, pipelines and the import ask this
 * router, which sends github.com URLs to the GitHub App (docs/GITHUB.md) and other URLs to the org's
 * forge connection that serves them. Generic git servers get nothing (node credentials, hand-made
 * webhooks), exactly as before.
 */

/** Where a repository lives, for matching events to git sources and pipeline repositories. */
export type RepositoryIdentity = string;

export interface GitRepositoryRef {
	/** Absent: the GitHub App. */
	connectionId?: string | null;
	fullName: string;
}

export interface GitDeploymentInput {
	sha: string;
	ref: string;
	environment: string;
	production: boolean;
	description: string;
	environmentUrl: string;
	logUrl: string;
}

export class GitProviders {
	constructor(private readonly ctx: CoreContext) {}

	/**
	 * `github:owner/repo`, `forge:<connection>:<full name>` or `url:<host/path>`, lower case.
	 * Two URLs name the same repository exactly when their identities are equal.
	 */
	identity(orgId: string, url: string): RepositoryIdentity | null {
		const github = parseGithubRepoUrl(url);
		if (github) return `github:${github.owner}/${github.repo}`.toLowerCase();
		const forge = this.ctx.forges.connectionFor(orgId, url);
		if (forge) return `forge:${forge.row.id}:${forge.fullName.toLowerCase()}`;
		const key = repoKey(url);
		return key ? `url:${key}` : null;
	}

	githubIdentity(fullName: string): RepositoryIdentity {
		return `github:${fullName}`.toLowerCase();
	}

	/** What serves a repository URL and whether its events arrive without a hand-made webhook. */
	link(orgId: string, url: string): GitProviderLink {
		const github = parseGithubRepoUrl(url);
		if (github) {
			const installationId = this.ctx.githubApp.repositoryLink(orgId, url).installationId;
			return { kind: 'github', connectionId: null, via: installationId ? 'GitHub App' : null, delivered: installationId !== null };
		}
		const forge = this.ctx.forges.connectionFor(orgId, url);
		if (forge)
			return {
				kind: forge.row.kind,
				connectionId: forge.row.id,
				via: forge.row.name,
				delivered: this.ctx.forges.deliversFor(forge.row.id, forge.fullName),
			};
		return { kind: 'generic', connectionId: null, via: null, delivered: false };
	}

	/** The provider a pipeline repository should record for a clone URL. */
	providerKind(orgId: string, url: string): GitProviderKind {
		return this.link(orgId, url).kind;
	}

	/**
	 * A Skiff-managed delivery already covers this repository, so a hand-made webhook is ignored.
	 * `payloadFullName` (the repository the delivery names) wins over the configured URL's name, as
	 * the hand-made webhook may sit on another repository than the one configured.
	 */
	async deliversFor(orgId: string, url: string, payloadFullName?: string | null): Promise<boolean> {
		const github = parseGithubRepoUrl(url);
		if (github) return this.ctx.githubApp.deliversFor(orgId, payloadFullName ?? `${github.owner}/${github.repo}`);
		const forge = this.ctx.forges.connectionFor(orgId, url);
		return forge ? this.ctx.forges.deliversFor(forge.row.id, payloadFullName ?? forge.fullName) : false;
	}

	/** Clone credentials for one repository (D164, D175), or null for the node's own. Never throws. */
	async cloneAuth(orgId: string, url: string): Promise<ForgeCloneAuth | null> {
		try {
			if (parseGithubRepoUrl(url)) {
				const access = await this.ctx.githubApp.repoToken(orgId, url, { contents: 'read' });
				return access ? { host: 'github.com', username: 'x-access-token', token: access.token } : null;
			}
			return await this.ctx.forges.cloneAuth(orgId, url);
		} catch (error) {
			console.warn(`[git] no clone credentials for ${url}: ${(error as Error).message}`);
			return null;
		}
	}

	/** Best-effort commit status on whichever provider serves the URL. */
	async commitStatus(orgId: string, url: string, report: ForgeStatusReport): Promise<boolean> {
		if (parseGithubRepoUrl(url))
			return this.ctx.githubApp.commitStatus(orgId, url, { ...report, state: report.state === 'running' ? 'pending' : report.state });
		return this.ctx.forges.commitStatus(orgId, url, report);
	}

	/** Best-effort deployment record (GitHub deployments, GitLab deployments). */
	async deployment(orgId: string, url: string, input: GitDeploymentInput): Promise<void> {
		if (parseGithubRepoUrl(url)) {
			await this.ctx.githubApp.deployment(orgId, url, {
				sha: input.sha,
				environment: input.environment,
				production: input.production,
				description: input.description,
				environmentUrl: input.environmentUrl,
				logUrl: input.logUrl,
				state: 'success',
			});
			return;
		}
		await this.ctx.forges.deployment(orgId, url, {
			sha: input.sha,
			ref: input.ref,
			environment: input.environment,
			environmentUrl: input.environmentUrl,
			production: input.production,
		});
	}

	/** Create the forge webhook for a repository a git source or pipeline uses (D174). Fire and forget. */
	ensureWebhook(orgId: string, url: string): void {
		if (parseGithubRepoUrl(url)) return;
		void this.ctx.forges.ensureWebhook(orgId, url).catch((error: Error) => console.warn(`[git] webhook for ${url}: ${error.message}`));
	}

	/**
	 * The org's automatic-pipeline ignore-list key for a URL (D172, D177): `owner/repo` on GitHub
	 * (as before), `host[/base]/full name` on a connected forge, null otherwise.
	 */
	autoSetupKey(orgId: string, url: string): string | null {
		const github = parseGithubRepoUrl(url);
		if (github) return `${github.owner}/${github.repo}`;
		const forge = this.ctx.forges.connectionFor(orgId, url);
		return forge ? `${forgeBaseKey(forge.row.baseUrl)}/${forge.fullName}` : null;
	}

	/** Every provider's repositories for one org, for pickers. Never throws for a provider. */
	async repositories(principal: Principal, options: { refresh?: boolean } = {}): Promise<GitRepositoryList> {
		this.ctx.iam.require(principal, 'build:read', { type: 'org' });
		const result: GitRepositoryList = {
			repositories: [],
			errors: [],
			truncated: false,
			github: false,
			connections: this.ctx.forges.summaries(principal.orgId),
		};
		const [github, forges] = await Promise.all([
			this.ctx.githubApp.repositories(principal, options).catch((error: Error) => ({ connected: false, repositories: [], truncated: false, error: error.message, manageUrl: null })),
			this.ctx.forges.repositories(principal.orgId, options),
		]);
		result.github = github.connected;
		result.truncated = github.truncated || forges.truncated;
		if (github.error) result.errors.push({ provider: 'github', connectionId: null, name: 'GitHub App', error: github.error });
		for (const repo of github.repositories)
			result.repositories.push({
				provider: 'github',
				connectionId: null,
				fullName: repo.fullName,
				owner: repo.owner,
				name: repo.name,
				private: repo.private,
				archived: repo.archived,
				defaultBranch: repo.defaultBranch,
				cloneUrl: repo.cloneUrl,
				htmlUrl: repo.htmlUrl,
				pushedAt: repo.pushedAt,
				key: githubRepoKey(repo.fullName),
			});
		result.repositories.push(...forges.repositories);
		for (const error of forges.errors) result.errors.push({ provider: error.kind, connectionId: error.connectionId, name: error.name, error: error.error });
		result.repositories.sort((a, b) => a.fullName.localeCompare(b.fullName) || a.provider.localeCompare(b.provider));
		return result;
	}

	/** One repository through the GitHub App or a connection; null when it cannot be reached. */
	async repository(orgId: string, ref: GitRepositoryRef): Promise<GitRepositoryView | null> {
		if (ref.connectionId) return this.ctx.forges.repository(orgId, ref.connectionId, ref.fullName);
		const repo = await this.ctx.githubApp.repository(orgId, ref.fullName);
		if (!repo) return null;
		return {
			provider: 'github',
			connectionId: null,
			fullName: repo.fullName,
			owner: repo.owner,
			name: repo.name,
			private: repo.private,
			archived: repo.archived,
			defaultBranch: repo.defaultBranch,
			cloneUrl: repo.cloneUrl,
			htmlUrl: repo.htmlUrl,
			pushedAt: repo.pushedAt,
			key: githubRepoKey(repo.fullName),
		};
	}

	async readPath(orgId: string, ref: GitRepositoryRef, path: string, gitRef?: string): Promise<GithubPathContent | null> {
		if (ref.connectionId) return this.ctx.forges.readPath(orgId, ref.connectionId, ref.fullName, path, gitRef);
		return this.ctx.githubApp.readPath(orgId, ref.fullName, path, gitRef);
	}

	/** "GitHub App", or a connection's name, for messages. */
	label(orgId: string, ref: GitRepositoryRef): string {
		if (!ref.connectionId) return FORGE_LABELS.github;
		const summary = this.ctx.forges.summaries(orgId).find((entry) => entry.id === ref.connectionId);
		return summary ? `${FORGE_LABELS[summary.kind]} (${summary.name})` : 'the git provider';
	}
}
