import * as z from 'zod';
import {
	PIPELINE_WORKFLOW_DIR,
	pipelineConclusions,
	pipelineRunStatuses,
	type Permission,
	type PipelineJobView,
	type PipelineLogLine,
	type PipelineRunSummary,
	type PipelineRunView,
	type PipelineTriggerView,
	type Principal,
} from '@skiff/contracts';
import { core } from './core';

/**
 * Task-shaped Pipelines tools for coding agents (docs/PIPELINES.md §8): list runs, read one run
 * with the failing job's log tail, dispatch a workflow, re-run, cancel. `mcp.ts` registers them
 * with its usual auditing and scope challenges.
 *
 * Deliberately missing: setting secrets or variables, approving environment deployments, and
 * repository settings. Those are human decisions (dashboard or `skif`). Nothing here returns a
 * secret value, a job token, a webhook secret or an artifact download URL; job outputs are left
 * out too, since a workflow can put anything in them.
 */

export interface PipelineToolSpec {
	name: string;
	config: {
		title: string;
		description: string;
		inputSchema: z.ZodObject;
		annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint?: boolean };
	};
	/** Scopes the MCP token needs (checked again by the service layer). */
	permissions: Permission[];
	handler: (args: Record<string, unknown>) => Promise<unknown> | unknown;
}

/** Log lines `get_pipeline_run` returns for the failed job. */
export const PIPELINE_LOG_TAIL = 200;
const LOG_PAGE = 5000;
/** Stop reading a huge log after this many pages; the tail is then of what was read. */
const LOG_MAX_PAGES = 40;
const LOG_LINE_MAX = 2000;
const DISPATCH_MAX_WAIT_SECONDS = 25;

const repo = z.string().min(1).max(100).describe('Repository name, as in list_pipeline_runs or the dashboard');
const runRef = z
	.string()
	.min(1)
	.max(64)
	.describe('Run number (42 or #42) or run id');

const statusValues = [...pipelineRunStatuses, ...pipelineConclusions] as const;

const FAILED = new Set(['failure', 'timed_out']);

function workflowPath(workflow: string): string {
	return workflow.includes('/') ? workflow.replace(/^\.?\//, '') : `${PIPELINE_WORKFLOW_DIR}/${workflow}`;
}

function summary(run: PipelineRunSummary & { error?: string | null }) {
	return {
		id: run.id,
		repository: run.repository,
		number: run.number,
		workflow: run.workflowName,
		workflowPath: run.workflowPath,
		event: run.event,
		ref: run.ref,
		sha: run.sha,
		title: run.title,
		actor: run.actor,
		trust: run.trust,
		status: run.status,
		conclusion: run.conclusion,
		attempt: run.attempt,
		error: run.error ?? null,
		createdAt: run.createdAt,
		startedAt: run.startedAt,
		finishedAt: run.finishedAt,
	};
}

function jobSummary(job: PipelineJobView) {
	const failingStep = job.steps.find((step) => step.conclusion !== null && FAILED.has(step.conclusion));
	return {
		id: job.id,
		key: job.key,
		name: job.name,
		matrix: job.matrix,
		needs: job.needs,
		status: job.status,
		conclusion: job.conclusion,
		environment: job.environment,
		node: job.nodeName,
		attempt: job.attempt,
		error: job.error,
		startedAt: job.startedAt,
		finishedAt: job.finishedAt,
		failingStep: failingStep ? { index: failingStep.index, number: failingStep.index + 1, name: failingStep.name } : null,
		steps: job.steps.map((step) => ({ number: step.index + 1, name: step.name, status: step.status, conclusion: step.conclusion })),
	};
}

function formatLine(job: PipelineJobView, line: PipelineLogLine): string {
	const text = line.text.length > LOG_LINE_MAX ? `${line.text.slice(0, LOG_LINE_MAX)}…` : line.text;
	if (line.step < 0) return `[setup] ${text}`;
	const name = job.steps.find((step) => step.index === line.step)?.name ?? `Step ${line.step + 1}`;
	return `[${line.step + 1} ${name}] ${text}`;
}

/** The last `PIPELINE_LOG_TAIL` lines of a job, paging forward through the log (it is stored oldest first). */
function logTail(principal: Principal, repository: string, run: PipelineRunView, job: PipelineJobView) {
	let tail: PipelineLogLine[] = [];
	let after = 0;
	let total = 0;
	let complete = true;
	for (let page = 0; page < LOG_MAX_PAGES; page++) {
		const result = core.pipelines.jobLogs(principal, repository, run.id, job.id, { after, limit: LOG_PAGE });
		total += result.lines.length;
		tail = [...tail, ...result.lines].slice(-PIPELINE_LOG_TAIL);
		after = result.next;
		if (result.lines.length < LOG_PAGE) break;
		if (page === LOG_MAX_PAGES - 1) complete = false;
	}
	return {
		lines: tail.map((line) => formatLine(job, line)),
		linesInLog: complete ? total : `more than ${total}`,
		truncated: total > tail.length,
	};
}

async function describeRun(principal: Principal, repository: string, run: PipelineRunView) {
	const failedJob = run.jobs.find((job) => job.conclusion !== null && FAILED.has(job.conclusion)) ?? null;
	const failure = failedJob
		? {
				job: { id: failedJob.id, key: failedJob.key, name: failedJob.name, error: failedJob.error },
				step: jobSummary(failedJob).failingStep,
				log: logTail(principal, repository, run, failedJob),
			}
		: null;
	const nextSteps: string[] = [];
	if (run.status !== 'completed') nextSteps.push(`Still ${run.status.replace('_', ' ')}: call get_pipeline_run again in a little while.`);
	if (failedJob) nextSteps.push('Fix the cause, push, or re-run only the failed jobs with rerun_pipeline_run (failed_only: true).');
	const waiting = run.jobs.filter((job) => job.status === 'waiting');
	if (waiting.length > 0)
		nextSteps.push(
			`${waiting.map((job) => job.name).join(', ')} waits for an environment approval. Only a person can approve it, in the dashboard.`,
		);
	return {
		run: { ...summary(run), inputs: run.inputs },
		jobs: run.jobs.map(jobSummary),
		artifacts: run.artifacts.map((artifact) => ({ name: artifact.name, size: artifact.size, expiresAt: artifact.expiresAt })),
		failure,
		...(nextSteps.length ? { nextSteps } : {}),
	};
}

/** Hold until a build node has read the workflow (or `waitSeconds` passes). */
async function settleTrigger(principal: Principal, repository: string, trigger: PipelineTriggerView, waitSeconds: number): Promise<PipelineTriggerView> {
	const deadline = Date.now() + waitSeconds * 1000;
	let current = trigger;
	while (current.status === 'resolving' && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 250));
		current = core.pipelines.getTrigger(principal, repository, trigger.id);
	}
	return current;
}

interface DeployFromGitInput {
	repository: string;
	connectionId?: string;
	branch?: string;
	rootDir?: string;
	name?: string;
	slug?: string;
	runtime?: 'static' | 'process';
	buildCommand?: string;
	outputDir?: string;
	pipelines?: boolean;
}

export function pipelineTools(principal: Principal): PipelineToolSpec[] {
	/** Detect, then import with the detected preset unless overridden (deploy_from_github / deploy_from_git). */
	const deployFromGit = async (input: DeployFromGitInput) => {
		const detected = await core.githubImport.detect(principal, {
			repository: input.repository,
			...(input.connectionId ? { connectionId: input.connectionId } : {}),
			branch: input.branch,
			rootDir: input.rootDir,
		});
		const preset = detected.preset;
		const runtime = input.runtime ?? preset.runtime;
		const result = await core.githubImport.importRepository(principal, {
			repository: detected.repository.fullName,
			...(input.connectionId ? { connectionId: input.connectionId } : {}),
			branch: detected.branch,
			rootDir: detected.rootDir,
			name: input.name ?? detected.suggestedName,
			...(input.slug ? { slug: input.slug } : {}),
			framework: preset.id,
			runtime,
			buildCommand: input.buildCommand ?? preset.buildCommand,
			outputDir: input.outputDir ?? preset.outputDir,
			...(runtime === 'process' && preset.runtime === 'process'
				? { ...(preset.command ? { command: preset.command } : {}), ...(preset.engine ? { engine: preset.engine } : {}), ...(preset.port ? { port: preset.port } : {}) }
				: {}),
			pipelines: input.pipelines ?? true,
		});
		return { ...result, framework: preset.label, branch: detected.branch, url: `/projects/${result.project.slug}` };
	};
	return [
		{
			name: 'list_github_repositories',
			config: {
				title: 'List GitHub repositories',
				description:
					'Repositories the org can use through Skiff\'s GitHub App (docs/GITHUB.md): full name, clone URL, default branch, private. ' +
					'Use a clone URL from here for a git build source or a pipeline repository: events, private clones and commit statuses then ' +
					'need no webhook or token. `connected: false` means no installation is linked; an org owner installs the App in Settings → GitHub.',
				inputSchema: z.object({
					query: z.string().min(1).max(100).optional().describe('Only repositories whose full name contains this'),
				}),
				annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
			},
			permissions: ['build:read'],
			handler: async (args) => {
				const query = (args as { query?: string }).query?.toLowerCase();
				const list = await core.githubApp.repositories(principal);
				const repositories = list.repositories
					.filter((repo) => !query || repo.fullName.toLowerCase().includes(query))
					.slice(0, 200)
					.map((repo) => ({ fullName: repo.fullName, cloneUrl: repo.cloneUrl, defaultBranch: repo.defaultBranch, private: repo.private, archived: repo.archived }));
				return { connected: list.connected, repositories, truncated: list.truncated, ...(list.error ? { error: list.error } : {}) };
			},
		},
		{
			name: 'deploy_from_github',
			config: {
				title: 'Deploy a GitHub repository',
				description:
					'Create a project from a repository Skiff\'s GitHub App can reach (see list_github_repositories), like Vercel\'s "Import Git Repository": ' +
					'Skiff reads the repository, picks a framework preset (build command, output directory, static or process app), connects it as the git source, ' +
					'queues the first build (promoted when it succeeds) and, when the repository has .skiff/workflows, adds it to Pipelines. Every later push to the ' +
					'branch builds and deploys through the App; nothing has to be set up on GitHub. Pass buildCommand/outputDir/runtime only to override the detected preset. ' +
					'Returns the project slug and the build id; follow the build with the project tools.',
				inputSchema: z.object({
					repository: z.string().min(3).max(201).describe('owner/name, as list_github_repositories returns it'),
					branch: z.string().min(1).max(255).optional().describe('Branch to build and deploy on push (default: the repository default branch)'),
					rootDir: z.string().max(512).optional().describe('Directory of the app inside the repository (monorepos), default "."'),
					name: z.string().min(1).max(120).optional().describe('Project name (default: the repository name)'),
					slug: z.string().min(3).max(40).optional().describe('Project slug, which is also the hostname (default: derived from the name)'),
					runtime: z.enum(['static', 'process']).optional().describe('Override the detected runtime'),
					buildCommand: z.string().min(1).max(2048).optional().describe('Override the detected build command'),
					outputDir: z.string().min(1).max(512).optional().describe('Override the detected output directory (relative to rootDir)'),
					pipelines: z.boolean().optional().describe('Add the repository to Pipelines when it has .skiff/workflows (default true)'),
				}),
				annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
			},
			permissions: ['project:create', 'build:create'],
			handler: async (args) => deployFromGit(args as unknown as DeployFromGitInput),
		},
		{
			name: 'list_git_repositories',
			config: {
				title: 'List git repositories (every provider)',
				description:
					'Repositories from every git provider the org connects (docs/FORGES.md): the GitHub App and each GitLab, Gitea or Forgejo connection. ' +
					'Each row has provider, connectionId (null for GitHub), full name (GitLab names may be nested: group/sub/repo), clone URL, default branch and private. ' +
					'Use a clone URL for a git build source or pipeline repository: Skiff creates the webhook, clones privately and posts commit statuses. ' +
					'`errors` lists providers that could not be asked; owners connect forges in Settings → Git providers.',
				inputSchema: z.object({
					query: z.string().min(1).max(100).optional().describe('Only repositories whose full name contains this'),
					provider: z.enum(['github', 'gitlab', 'gitea', 'forgejo']).optional().describe('Only this provider'),
				}),
				annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
			},
			permissions: ['build:read'],
			handler: async (args) => {
				const { query, provider } = args as { query?: string; provider?: string };
				const list = await core.git.repositories(principal);
				const repositories = list.repositories
					.filter((repo) => (!query || repo.fullName.toLowerCase().includes(query.toLowerCase())) && (!provider || repo.provider === provider))
					.slice(0, 200)
					.map((repo) => ({
						provider: repo.provider,
						connectionId: repo.connectionId,
						fullName: repo.fullName,
						cloneUrl: repo.cloneUrl,
						defaultBranch: repo.defaultBranch,
						private: repo.private,
					}));
				return { github: list.github, connections: list.connections, repositories, truncated: list.truncated, errors: list.errors };
			},
		},
		{
			name: 'deploy_from_git',
			config: {
				title: 'Deploy a repository from any git provider',
				description:
					'deploy_from_github for every provider: create a project from a repository listed by list_git_repositories (GitHub App, GitLab, Gitea or Forgejo). ' +
					'Pass connectionId for GitLab/Gitea/Forgejo (omit it for GitHub). Skiff detects a framework preset, connects the git source (creating the forge webhook), ' +
					'queues the first build (promoted on success) and adds the repository to Pipelines when it has .skiff/workflows. ' +
					'Pass buildCommand/outputDir/runtime only to override the detected preset.',
				inputSchema: z.object({
					repository: z.string().min(3).max(512).describe('Full name as list_git_repositories returns it'),
					connectionId: z.string().min(1).max(64).optional().describe('The forge connection (omit for the GitHub App)'),
					branch: z.string().min(1).max(255).optional().describe('Branch to build and deploy on push (default: the repository default branch)'),
					rootDir: z.string().max(512).optional().describe('Directory of the app inside the repository (monorepos), default "."'),
					name: z.string().min(1).max(120).optional().describe('Project name (default: the repository name)'),
					slug: z.string().min(3).max(40).optional().describe('Project slug, which is also the hostname (default: derived from the name)'),
					runtime: z.enum(['static', 'process']).optional().describe('Override the detected runtime'),
					buildCommand: z.string().min(1).max(2048).optional().describe('Override the detected build command'),
					outputDir: z.string().min(1).max(512).optional().describe('Override the detected output directory (relative to rootDir)'),
					pipelines: z.boolean().optional().describe('Add the repository to Pipelines when it has .skiff/workflows (default true)'),
				}),
				annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
			},
			permissions: ['project:create', 'build:create'],
			handler: async (args) => deployFromGit(args as unknown as DeployFromGitInput),
		},
		{
			name: 'list_pipeline_runs',
			config: {
				title: 'List pipeline runs',
				description:
					'Pipeline (CI) runs, newest first: number, workflow, event, ref, sha, title, status (queued/in_progress/completed) and conclusion ' +
					'(success/failure/cancelled/skipped/timed_out). With `repo`, that repository\'s runs; without, recent runs across the org. ' +
					'`status` takes a status or a conclusion (e.g. failure). Read one with get_pipeline_run.',
				inputSchema: z.object({
					repo: repo.optional(),
					status: z.enum(statusValues).optional().describe('A run status, or a conclusion such as failure'),
					workflow: z.string().min(1).max(512).optional().describe('Workflow file (ci.yml or .skiff/workflows/ci.yml); needs repo'),
					limit: z.number().int().min(1).max(100).default(20),
				}),
				annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			},
			permissions: ['build:read'],
			handler: (args) => {
				const { repo: name, status, workflow, limit } = args as { repo?: string; status?: string; workflow?: string; limit: number };
				const conclusion = status && !(pipelineRunStatuses as readonly string[]).includes(status) ? status : undefined;
				const runStatus = conclusion ? 'completed' : status;
				let runs: Array<PipelineRunSummary & { error?: string | null }>;
				if (name) {
					runs = core.pipelines.listRuns(principal, name, {
						...(runStatus ? { status: runStatus } : {}),
						...(workflow ? { workflow: workflowPath(workflow) } : {}),
						limit: conclusion ? 100 : limit,
					});
				} else {
					if (workflow) throw new Error('Filtering by workflow needs repo.');
					runs = core.pipelines.recentRuns(principal, 100).filter((run) => !runStatus || run.status === runStatus);
				}
				if (conclusion) runs = runs.filter((run) => run.conclusion === conclusion);
				return { runs: runs.slice(0, limit).map(summary) };
			},
		},
		{
			name: 'get_pipeline_run',
			config: {
				title: 'Get pipeline run',
				description:
					'One pipeline run: summary, every job with its steps (status, conclusion, the failing step), artifact names, and for the first ' +
					`failed job the last ${PIPELINE_LOG_TAIL} log lines, each prefixed with [step number and name]. Use it to find out why CI failed.`,
				inputSchema: z.object({ repo, run: runRef }),
				annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			},
			permissions: ['build:read'],
			handler: async (args) => {
				const { repo: name, run } = args as { repo: string; run: string };
				return describeRun(principal, name, await core.pipelines.getRun(principal, name, run.replace(/^#/, '')));
			},
		},
		{
			name: 'dispatch_workflow',
			config: {
				title: 'Dispatch workflow',
				description:
					'Start a workflow run (workflow_dispatch) on a repository\'s build nodes. Give `workflow`, a file in .skiff/workflows of the repository ' +
					'(ci.yml), or `workflow_text`, inline workflow YAML (GitHub Actions syntax) run against `ref` without committing it. `ref` defaults to ' +
					'the default branch. `inputs` are the workflow_dispatch inputs, which are visible in the run: never put credentials in them; secrets ' +
					'are set by a person (dashboard or `skif secret set`) and read by the workflow as ${{ secrets.NAME }}. A committed workflow runs for ' +
					'real with the repository\'s secrets and may deploy; a `workflow_text` run is always untrusted (no secrets, environments or deploys), ' +
					'so use it to try a workflow, not to ship. Waits up to wait_seconds for a build node to read the workflow and returns the trigger ' +
					'and the runs it started; follow them with get_pipeline_run.',
				inputSchema: z.object({
					repo,
					workflow: z.string().min(1).max(512).optional().describe('Workflow file: ci.yml or .skiff/workflows/ci.yml'),
					workflow_text: z.string().min(1).max(512_000).optional().describe('Inline workflow YAML, instead of workflow'),
					ref: z.string().min(1).max(255).optional().describe('Branch, tag or sha (default: the default branch)'),
					inputs: z
						.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
						.default({})
						.describe('workflow_dispatch inputs (no secrets)'),
					wait_seconds: z.number().int().min(0).max(DISPATCH_MAX_WAIT_SECONDS).default(10),
				}),
				annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
			},
			permissions: ['build:create'],
			handler: async (args) => {
				const input = args as {
					repo: string;
					workflow?: string;
					workflow_text?: string;
					ref?: string;
					inputs: Record<string, string | number | boolean>;
					wait_seconds: number;
				};
				if (Boolean(input.workflow) === Boolean(input.workflow_text)) throw new Error('Give exactly one of workflow or workflow_text.');
				const started = core.pipelines.dispatch(principal, input.repo, {
					...(input.workflow ? { workflow: input.workflow } : {}),
					...(input.workflow_text ? { workflowText: input.workflow_text } : {}),
					...(input.ref ? { ref: input.ref } : {}),
					inputs: input.inputs ?? {},
				});
				const trigger = await settleTrigger(principal, input.repo, started, input.wait_seconds ?? 10);
				const runs = await Promise.all(trigger.runIds.map(async (id) => summary(await core.pipelines.getRun(principal, input.repo, id))));
				const nextSteps =
					trigger.status === 'resolving'
						? ['No build node has read the workflow yet. Check list_pipeline_runs shortly; the run appears once it starts.']
						: trigger.status === 'failed'
							? ['The workflow did not start; see trigger.error.']
							: runs.length === 0
								? ['No run started: the workflow has no workflow_dispatch trigger, or it does not match this ref.']
								: [`Follow it with get_pipeline_run (repo: "${input.repo}", run: "${runs[0]!.number}").`];
				return { trigger, runs, nextSteps };
			},
		},
		{
			name: 'rerun_pipeline_run',
			config: {
				title: 'Re-run pipeline run',
				description:
					'Run a pipeline run again as a new attempt of the same commit and inputs. failed_only re-runs only the failed or cancelled jobs ' +
					'and the jobs that depend on them. It runs the workflow for real, with the repository\'s secrets.',
				inputSchema: z.object({ repo, run: runRef, failed_only: z.boolean().default(false) }),
				annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
			},
			permissions: ['build:create'],
			handler: async (args) => {
				const { repo: name, run, failed_only } = args as { repo: string; run: string; failed_only: boolean };
				const view = await core.pipelines.rerun(principal, name, run.replace(/^#/, ''), failed_only ?? false);
				return { run: summary(view), jobs: view.jobs.map((job) => ({ name: job.name, status: job.status, conclusion: job.conclusion })) };
			},
		},
		{
			name: 'cancel_pipeline_run',
			config: {
				title: 'Cancel pipeline run',
				description: 'Cancel a queued or running pipeline run. Running jobs stop after their always() steps; a completed run cannot be cancelled.',
				inputSchema: z.object({ repo, run: runRef }),
				annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
			},
			permissions: ['build:cancel'],
			handler: async (args) => {
				const { repo: name, run } = args as { repo: string; run: string };
				const view = await core.pipelines.cancelRun(principal, name, run.replace(/^#/, ''));
				return { run: summary(view) };
			},
		},
	];
}
