import {
	detectFramework,
	githubImportDetectSchema,
	githubImportSchema,
	parseGithubRepoUrl,
	sameGithubRepo,
	workloadSpecSchema,
	type GithubImportDetectInput,
	type GithubImportDetection,
	type GithubImportInput,
	type GithubImportResult,
	type GithubRepositoryView,
	type Principal,
} from '@skiff/contracts';
import type { CoreContext } from './context.ts';
import { CoreError, ValidationError } from './errors.ts';

const WORKFLOW_DIR = '.skiff/workflows';
/** Directories never offered as a root directory. */
const HIDDEN_DIRECTORIES = new Set(['node_modules', '.git', '.github', '.skiff', '.vscode', '.idea']);

/**
 * Deploy from GitHub (docs/GITHUB.md §9, D172): read a repository through the org's GitHub App,
 * guess how to build it, then create the project, its git source, the first build and, when the
 * repository has workflows, its pipeline repository in one step. Everything after that is the
 * existing machinery: pushes arrive on the App's webhook (D165), Builders clone with an
 * installation token (D164), and each build reports a commit status and a GitHub deployment.
 */
export class GithubImportService {
	constructor(private readonly ctx: CoreContext) {}

	private async requireRepository(orgId: string, fullName: string): Promise<GithubRepositoryView> {
		const repo = await this.ctx.githubApp.repository(orgId, fullName);
		if (!repo)
			throw new CoreError(
				'github_installation_missing',
				`Skiff's GitHub App cannot reach ${fullName} for this organisation. Install it on ${fullName.split('/')[0]}, or grant it the repository, in Settings → GitHub.`,
				409,
			);
		if (repo.archived) throw new ValidationError(`${repo.fullName} is archived on GitHub, so it cannot be built on push.`);
		return repo;
	}

	/** Look at a repository (and a root directory in it) and suggest how to build it. */
	async detect(principal: Principal, input: GithubImportDetectInput): Promise<GithubImportDetection> {
		this.ctx.iam.require(principal, 'project:create', { type: 'org' });
		const parsed = githubImportDetectSchema.parse(input);
		const repo = await this.requireRepository(principal.orgId, parsed.repository);
		const branch = parsed.branch ?? repo.defaultBranch;
		const rootDir = normalizeDir(parsed.rootDir);
		const listing = await this.ctx.githubApp.readPath(principal.orgId, repo.fullName, rootDir, branch);
		if (!listing || listing.kind !== 'dir')
			throw new ValidationError(
				rootDir === '.' ? `${repo.fullName} has no branch "${branch}", or it is empty.` : `There is no directory "${rootDir}" on ${branch}.`,
			);
		const names = listing.entries.map((entry) => entry.name);
		let packageJson: unknown = null;
		if (listing.entries.some((entry) => entry.type === 'file' && entry.name === 'package.json')) {
			const file = await this.ctx.githubApp.readPath(principal.orgId, repo.fullName, joinDir(rootDir, 'package.json'), branch);
			if (file?.kind === 'file' && file.text) {
				try {
					packageJson = JSON.parse(file.text);
				} catch {
					// A broken package.json still gets a preset from the file names.
				}
			}
		}
		const workflows = await this.workflows(principal.orgId, repo.fullName, branch);
		const packageName = (packageJson as { name?: unknown } | null)?.name;
		return {
			repository: {
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

	private async workflows(orgId: string, fullName: string, ref: string): Promise<string[]> {
		try {
			const listing = await this.ctx.githubApp.readPath(orgId, fullName, WORKFLOW_DIR, ref);
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
		const repo = await this.requireRepository(principal.orgId, parsed.repository);
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
		const workflows = parsed.pipelines ? await this.workflows(principal.orgId, repo.fullName, branch) : [];

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
			const existing = this.ctx.pipelines
				.listRepositories(principal)
				.find((row) => {
					const other = parseGithubRepoUrl(row.cloneUrl);
					return other !== null && sameGithubRepo(`${other.owner}/${other.repo}`, repo.fullName);
				});
			if (existing) pipelineRepository = existing.name;
			else {
				try {
					pipelineRepository = this.ctx.pipelines.createRepository(principal, {
						name: this.ctx.pipelines.freeRepositoryName(principal.orgId, repo.fullName),
						cloneUrl: repo.cloneUrl,
						provider: 'github',
						defaultBranch: repo.defaultBranch,
					}).name;
				} catch (error) {
					warnings.push(`Pipelines were not set up: ${(error as Error).message}`);
				}
			}
		}

		this.ctx.audit.record({
			principal,
			action: 'github.import',
			resource: 'project',
			resourceId: project.id,
			args: { repository: repo.fullName, branch, runtime: parsed.runtime, framework: parsed.framework ?? null, pipelineRepository },
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
