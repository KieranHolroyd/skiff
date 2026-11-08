import {
	detectFramework,
	githubImportDetectSchema,
	githubImportSchema,
	workloadSpecSchema,
	FORGE_LABELS,
	type GithubImportDetectInput,
	type GithubImportDetection,
	type GithubImportInput,
	type GithubImportResult,
	type GitRepositoryView,
	type Principal,
} from '@skiff/contracts';
import type { CoreContext } from './context.ts';
import { CoreError, ValidationError } from './errors.ts';
import type { GitRepositoryRef } from './forges/router.ts';

const WORKFLOW_DIR = '.skiff/workflows';
/** Directories never offered as a root directory. */
const HIDDEN_DIRECTORIES = new Set(['node_modules', '.git', '.github', '.skiff', '.vscode', '.idea']);

/**
 * Deploy from Git (docs/GITHUB.md §9, D172; docs/FORGES.md §7, D177): read a repository through
 * the org's GitHub App or a GitLab/Gitea/Forgejo connection, guess how to build it, then create the
 * project, its git source, the first build and, when the repository has workflows, its pipeline
 * repository in one step. Everything after that is the existing machinery: pushes arrive on the
 * App's webhook (D165) or the hook Skiff creates on the forge (D174), Builders clone with a
 * narrowed token (D164, D175), and each build reports a commit status and a deployment.
 */
export class GithubImportService {
	constructor(private readonly ctx: CoreContext) {}

	private async requireRepository(orgId: string, ref: GitRepositoryRef): Promise<GitRepositoryView> {
		const repo = await this.ctx.git.repository(orgId, ref);
		if (!repo)
			throw ref.connectionId
				? new CoreError(
						'forge_repository_missing',
						`${this.ctx.git.label(orgId, ref)} cannot reach ${ref.fullName} with its token. Check the repository name and the token's access in Settings → Git providers.`,
						409,
					)
				: new CoreError(
						'github_installation_missing',
						`Skiff's GitHub App cannot reach ${ref.fullName} for this organisation. Install it on ${ref.fullName.split('/')[0]}, or grant it the repository, in Settings → GitHub.`,
						409,
					);
		if (repo.archived) throw new ValidationError(`${repo.fullName} is archived on ${FORGE_LABELS[repo.provider]}, so it cannot be built on push.`);
		return repo;
	}

	/** Look at a repository (and a root directory in it) and suggest how to build it. */
	async detect(principal: Principal, input: GithubImportDetectInput): Promise<GithubImportDetection> {
		this.ctx.iam.require(principal, 'project:create', { type: 'org' });
		const parsed = githubImportDetectSchema.parse(input);
		const ref: GitRepositoryRef = { connectionId: parsed.connectionId ?? null, fullName: parsed.repository };
		const repo = await this.requireRepository(principal.orgId, ref);
		const at: GitRepositoryRef = { connectionId: ref.connectionId, fullName: repo.fullName };
		const branch = parsed.branch ?? repo.defaultBranch;
		const rootDir = normalizeDir(parsed.rootDir);
		const listing = await this.ctx.git.readPath(principal.orgId, at, rootDir, branch);
		if (!listing || listing.kind !== 'dir')
			throw new ValidationError(
				rootDir === '.' ? `${repo.fullName} has no branch "${branch}", or it is empty.` : `There is no directory "${rootDir}" on ${branch}.`,
			);
		const names = listing.entries.map((entry) => entry.name);
		let packageJson: unknown = null;
		if (listing.entries.some((entry) => entry.type === 'file' && entry.name === 'package.json')) {
			const file = await this.ctx.git.readPath(principal.orgId, at, joinDir(rootDir, 'package.json'), branch);
			if (file?.kind === 'file' && file.text) {
				try {
					packageJson = JSON.parse(file.text);
				} catch {
					// A broken package.json still gets a preset from the file names.
				}
			}
		}
		const workflows = await this.workflows(principal.orgId, at, branch);
		const packageName = (packageJson as { name?: unknown } | null)?.name;
		return {
			repository: {
				provider: repo.provider,
				connectionId: repo.connectionId,
				fullName: repo.fullName,
				cloneUrl: repo.cloneUrl,
				htmlUrl: repo.htmlUrl,
				defaultBranch: repo.defaultBranch,
				private: repo.private,
			},
			branch,
			rootDir,
			preset: detectFramework({ files: names, packageJson }),
			directories: listing.entries
				.filter((entry) => entry.type === 'dir' && !HIDDEN_DIRECTORIES.has(entry.name))
				.map((entry) => entry.name)
				.sort((a, b) => a.localeCompare(b)),
			workflows,
			hasDockerfile: names.some((name) => name.toLowerCase() === 'dockerfile'),
			suggestedName:
				typeof packageName === 'string' && packageName.trim() && rootDir !== '.'
					? (packageName.split('/').pop() ?? repo.name)
					: repo.name,
		};
	}

	private async workflows(orgId: string, at: GitRepositoryRef, ref: string): Promise<string[]> {
		try {
			const listing = await this.ctx.git.readPath(orgId, at, WORKFLOW_DIR, ref);
			return listing?.kind === 'dir'
				? listing.entries
						.filter((entry) => entry.type === 'file' && /\.ya?ml$/i.test(entry.name))
						.map((entry) => entry.name)
						.sort((a, b) => a.localeCompare(b))
				: [];
		} catch {
			return [];
		}
	}

	/**
	 * Create the project, its git source and the first build (promoted when it succeeds), plus a
	 * pipeline repository when asked and the repository has workflows. Everything that can be
	 * refused is checked before the project exists; later steps that fail are `warnings`.
	 */
	async importRepository(principal: Principal, input: GithubImportInput): Promise<GithubImportResult> {
		this.ctx.iam.require(principal, 'project:create', { type: 'org' });
		this.ctx.iam.require(principal, 'build:create', { type: 'org' });
		const parsed = githubImportSchema.parse(input);
		const ref: GitRepositoryRef = { connectionId: parsed.connectionId ?? null, fullName: parsed.repository };
		const repo = await this.requireRepository(principal.orgId, ref);
		const at: GitRepositoryRef = { connectionId: ref.connectionId, fullName: repo.fullName };
		const branch = parsed.branch ?? repo.defaultBranch;
		const spec =
			parsed.runtime === 'process'
				? workloadSpecSchema.parse({
						runtime: 'process',
						...(parsed.command ? { command: parsed.command } : parsed.engine === 'node' ? {} : { command: ['bun', 'run', 'start'] }),
						...(parsed.engine ? { engine: parsed.engine } : {}),
						...(parsed.port ? { port: parsed.port } : {}),
						...(parsed.env ? { env: parsed.env } : {}),
					})
				: null;
		const workflows = parsed.pipelines ? await this.workflows(principal.orgId, at, branch) : [];

		const view = await this.ctx.projects.create(principal, {
			name: parsed.name ?? repo.name,
			...(parsed.slug ? { slug: parsed.slug } : {}),
			runtime: parsed.runtime,
			placement: parsed.runtime === 'static' ? 'edge' : 'auto',
			productionAccess: parsed.productionAccess,
			previewAccess: parsed.previewAccess,
		});
		const project = this.ctx.projects.requireRow(principal, view.slug);
		const warnings: string[] = [];
		if (spec) this.ctx.workloads.setSpec(principal, project, spec);
		this.ctx.builds.upsertGitSource(principal, project, {
			repoUrl: repo.cloneUrl,
			branch,
			rootDir: normalizeDir(parsed.rootDir),
			buildCommand: parsed.buildCommand,
			outputDir: normalizeDir(parsed.outputDir),
			enabled: true,
		});

		let build: GithubImportResult['build'] = null;
		try {
			build = { id: this.ctx.builds.enqueue(principal, project, { ref: branch, promote: true, message: `Imported ${repo.fullName}` }).id };
		} catch (error) {
			warnings.push(`The first build was not queued: ${(error as Error).message}`);
		}

		let pipelineRepository: string | null = null;
		if (workflows.length > 0) {
			const identity = this.ctx.git.identity(principal.orgId, repo.cloneUrl);
			const existing = this.ctx.pipelines
				.listRepositories(principal)
				.find((row) => identity !== null && this.ctx.git.identity(principal.orgId, row.cloneUrl) === identity);
			if (existing) pipelineRepository = existing.name;
			else {
				try {
					pipelineRepository = this.ctx.pipelines.createRepository(principal, {
						name: this.ctx.pipelines.freeRepositoryName(principal.orgId, repo.fullName),
						cloneUrl: repo.cloneUrl,
						provider: repo.provider,
						defaultBranch: repo.defaultBranch,
					}).name;
				} catch (error) {
					warnings.push(`Pipelines were not set up: ${(error as Error).message}`);
				}
			}
		}

		this.ctx.audit.record({
			principal,
			action: repo.provider === 'github' ? 'github.import' : 'git.import',
			resource: 'project',
			resourceId: project.id,
			args: { provider: repo.provider, connectionId: repo.connectionId, repository: repo.fullName, branch, runtime: parsed.runtime, framework: parsed.framework ?? null, pipelineRepository },
			result: 'ok',
		});
		return { project: { id: project.id, slug: project.slug, name: project.name }, build, pipelineRepository, warnings };
	}
}

function normalizeDir(value: string): string {
	const trimmed = value.trim().replace(/^\.\/+/, '').replace(/\/+$/, '');
	return trimmed === '' ? '.' : trimmed;
}

function joinDir(dir: string, name: string): string {
	return dir === '.' ? name : `${dir}/${name}`;
}
