import * as z from 'zod';

/**
 * Git builds (D2, D3). The control plane never builds: it queues a job and a Builder on the
 * homelab claims it with the build node's token. The Builder uploads the resulting artifact
 * through the same presigned/object-store path as a CLI deploy, so downstream stays identical.
 */

export const buildStatuses = ['queued', 'building', 'succeeded', 'failed', 'cancelled'] as const;
export type BuildStatus = (typeof buildStatuses)[number];

const repoUrl = z
	.string()
	.min(4)
	.max(512)
	.refine(
		(value) => /^(https:\/\/|ssh:\/\/|git@|git:\/\/)/.test(value),
		'Repository must be an https, ssh or git URL',
	);

/** Per-project git configuration. The webhook secret is write-only (hashed at rest). */
export const gitSourceSchema = z.object({
	repoUrl,
	branch: z.string().min(1).max(255).default('main'),
	/** Directory containing the site/app, relative to the repository root. */
	rootDir: z
		.string()
		.max(512)
		.default('.')
		.refine((value) => !value.startsWith('/') && !value.split('/').includes('..'), 'rootDir must stay inside the repo'),
	/** Shell command run by the Builder (inside the worktree). */
	buildCommand: z.string().min(1).max(2048).default('bun install && bun run build'),
	/** Directory (relative to rootDir) whose contents become the artifact. */
	outputDir: z
		.string()
		.min(1)
		.max(512)
		.default('dist')
		.refine((value) => !value.startsWith('/') && !value.split('/').includes('..'), 'outputDir must stay inside the repo'),
	/** Optional webhook secret; when set, GitHub deliveries must carry a valid HMAC signature. */
	webhookSecret: z.string().min(16).max(256).optional(),
	enabled: z.boolean().default(true),
});
export type GitSourceInput = z.infer<typeof gitSourceSchema>;

export interface GitSourceView {
	id: string;
	projectId: string;
	projectSlug: string;
	repoUrl: string;
	branch: string;
	rootDir: string;
	buildCommand: string;
	outputDir: string;
	enabled: boolean;
	hasWebhookSecret: boolean;
	createdAt: string;
	updatedAt: string;
}

export const buildCreateSchema = z.object({
	/** Branch, tag or commit. Omitted means the git source's configured branch. */
	ref: z.string().min(1).max(255).optional(),
	message: z.string().max(500).optional(),
	/** Promote the resulting deployment to production when the build succeeds. */
	promote: z.boolean().default(true),
});
export type BuildCreate = z.infer<typeof buildCreateSchema>;

export interface BuildView {
	id: string;
	projectId: string;
	projectSlug: string;
	status: BuildStatus;
	ref: string;
	commitSha: string | null;
	commitMessage: string | null;
	releaseSha256: string | null;
	deploymentId: string | null;
	error: string | null;
	/** Tail of the build log; the full log is available from `/builds/:id` on request. */
	logTail: string | null;
	createdAt: string;
	startedAt: string | null;
	finishedAt: string | null;
}

export const buildLogChunkSchema = z.object({
	stream: z.enum(['stdout', 'stderr']).default('stdout'),
	lines: z.array(z.string().max(16_384)).max(500),
});
export type BuildLogChunk = z.infer<typeof buildLogChunkSchema>;

/** Builder -> control plane report for a claimed job. */
export const buildReportSchema = z.object({
	status: z.enum(buildStatuses),
	commitSha: z.string().max(64).optional(),
	commitMessage: z.string().max(2000).optional(),
	error: z.string().max(4000).optional(),
	/** Presigned upload URL the Builder should use, returned when it claims a job. */
});
export type BuildReport = z.infer<typeof buildReportSchema>;

export interface BuildJob {
	buildId: string;
	repoUrl: string;
	ref: string;
	commitSha: string | null;
	rootDir: string;
	buildCommand: string;
	outputDir: string;
	/** Presigned PUT for `builds/<id>.zip`; the Builder uploads, then reports success. */
	uploadUrl: string;
	/** Full clone URL with credentials when the repository is private. */
	auth?: { username: string; password: string } | null;
}
