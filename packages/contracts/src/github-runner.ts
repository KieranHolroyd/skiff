import * as z from 'zod';

/**
 * GitHub Actions self-hosted runners (plan 21, D89–D93).
 *
 * A runner project is a container worker (`ingress: "none"`) with a `runner` profile. Each replica
 * is an ephemeral runner: it takes one job, exits, and the agent re-applies it with a fresh
 * single-use JIT config that the control plane minted from the project's GitHub credential. The
 * credential itself (a PAT or a GitHub App private key) is a secret *reference*: it is read only by
 * the control plane and never enters the container, desired state or the agent.
 */

/** GitHub owner (user or organisation) login. */
export const githubOwnerSchema = z
	.string()
	.trim()
	.min(1)
	.max(39)
	.regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/, 'Enter a GitHub user or organisation name.');

/** Repository name (without the owner). */
export const githubRepoSchema = z
	.string()
	.trim()
	.min(1)
	.max(100)
	.regex(/^[A-Za-z0-9._-]+$/, 'Enter a repository name (letters, digits, ".", "_" and "-").')
	.refine((value) => value !== '.' && value !== '..', 'Enter a repository name.');

/** A runner label as used in `runs-on:`. */
export const githubRunnerLabelSchema = z
	.string()
	.trim()
	.min(1)
	.max(64)
	.regex(/^[A-Za-z0-9._-]+$/, 'Labels use letters, digits, ".", "_" and "-".');

const secretNameSchema = z
	.string()
	.regex(/^[A-Z][A-Z0-9_]*$/, 'Secret names must be UPPER_SNAKE_CASE')
	.max(128);

export const githubRunnerAuthMethods = ['pat', 'app', 'installation'] as const;
export type GithubRunnerAuthMethod = (typeof githubRunnerAuthMethods)[number];

/**
 * How the control plane authenticates to GitHub to mint JIT configs. Both name a project or org
 * secret; the value is never part of the spec.
 *
 * - `pat`: a fine-grained token with "Administration: write" on the repository, or "Self-hosted
 *   runners: write" on the organisation (a classic token needs `repo` / `admin:org`).
 * - `app`: a GitHub App installed on the repository or organisation with the same permission.
 *   The control plane signs a JWT with the private key and exchanges it for an installation token.
 * - `installation`: Yoal's own GitHub App (Settings → GitHub, D165). The org's linked installation
 *   on `owner` is used; nothing is stored on the project.
 */
export const githubRunnerAuthSchema = z.discriminatedUnion('method', [
	z.object({ method: z.literal('pat'), tokenSecret: secretNameSchema }),
	z.object({
		method: z.literal('app'),
		appId: z.number().int().positive(),
		installationId: z.number().int().positive(),
		privateKeySecret: secretNameSchema,
	}),
	z.object({ method: z.literal('installation') }),
]);
export type GithubRunnerAuth = z.infer<typeof githubRunnerAuthSchema>;

export const githubRunnerScopes = ['repo', 'org'] as const;
export type GithubRunnerScope = (typeof githubRunnerScopes)[number];

/** Labels every Yoal runner carries; GitHub does not add OS labels to JIT runners on its own. */
export const GITHUB_RUNNER_BASE_LABELS = ['self-hosted', 'linux'] as const;

export const githubRunnerSchema = z
	.object({
		provider: z.literal('github'),
		scope: z.enum(githubRunnerScopes),
		owner: githubOwnerSchema,
		/** Required for `repo` scope, rejected for `org` scope. */
		repo: githubRepoSchema.optional(),
		/** Extra labels for `runs-on:`; `self-hosted` and `linux` are always added. */
		labels: z.array(githubRunnerLabelSchema).max(20).default([]),
		/** Organisation runner group; `1` is the default group (repo runners always use 1). */
		runnerGroupId: z.number().int().positive().default(1),
		auth: githubRunnerAuthSchema,
	})
	.superRefine((runner, ctx) => {
		if (runner.scope === 'repo' && !runner.repo)
			ctx.addIssue({ code: 'custom', path: ['repo'], message: 'Choose the repository the runners serve.' });
		if (runner.scope === 'org' && runner.repo)
			ctx.addIssue({ code: 'custom', path: ['repo'], message: 'Organisation runners do not name a repository.' });
		if (runner.scope === 'repo' && runner.runnerGroupId !== 1)
			ctx.addIssue({
				code: 'custom',
				path: ['runnerGroupId'],
				message: 'Repository runners always use the default runner group.',
			});
	});
export type GithubRunner = z.infer<typeof githubRunnerSchema>;

/** The full label set sent to GitHub, base labels first, de-duplicated case-insensitively. */
export function githubRunnerLabels(runner: Pick<GithubRunner, 'labels'>): string[] {
	const seen = new Set<string>();
	const labels: string[] = [];
	for (const label of [...GITHUB_RUNNER_BASE_LABELS, ...runner.labels]) {
		const key = label.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		labels.push(label);
	}
	return labels;
}

/** `owner/repo` or `owner` for display and audit. */
export function githubRunnerTarget(runner: Pick<GithubRunner, 'scope' | 'owner' | 'repo'>): string {
	return runner.scope === 'repo' ? `${runner.owner}/${runner.repo ?? ''}` : runner.owner;
}

/** Secret names a runner spec reads on the control plane (never delivered to the container). */
export function githubRunnerSecretNames(runner: Pick<GithubRunner, 'auth'>): string[] {
	if (runner.auth.method === 'installation') return [];
	return [runner.auth.method === 'pat' ? runner.auth.tokenSecret : runner.auth.privateKeySecret];
}

/** Env var the runner's `run.sh` reads the JIT config from (`ACTIONS_RUNNER_INPUT_<ARG>`). */
export const GITHUB_RUNNER_JITCONFIG_ENV = 'ACTIONS_RUNNER_INPUT_JITCONFIG';

/** The upstream runner image; `latest` is pulled with `Pull=newer` on every recycle (D91). */
export const GITHUB_RUNNER_DEFAULT_IMAGE = 'ghcr.io/actions/actions-runner:latest';

/** Fixed entrypoint the helper derives for the runner profile (no command from the wire). */
export const GITHUB_RUNNER_COMMAND = ['/home/runner/run.sh'] as const;

/** One runner registered with GitHub, as the dashboard and API show it. */
export interface GithubRunnerView {
	/** GitHub's runner id; null when GitHub has not confirmed the registration. */
	id: number | null;
	name: string;
	replica: number;
	status: 'online' | 'offline' | 'unknown';
	busy: boolean;
	labels: string[];
	registeredAt: string;
}

export interface GithubRunnerPoolView {
	target: string;
	scope: GithubRunnerScope;
	replicas: number;
	labels: string[];
	auth: GithubRunnerAuthMethod;
	runners: GithubRunnerView[];
	/** Set when GitHub could not be reached or rejected the credential. */
	error: string | null;
}
