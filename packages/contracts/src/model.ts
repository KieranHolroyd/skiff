/** Hard limits enforced at finalize (DESIGN §4). */
export const limits = {
	/** Maximum size of one artifact (uncompressed). */
	artifactBytes: 500 * 1024 * 1024,
	/** Maximum size of one file inside an artifact. */
	fileBytes: 25 * 1024 * 1024,
	/** Maximum number of files in an artifact. */
	files: 20_000,
	/** Inline MCP deploys (base64 in a JSON tool argument). */
	inlineBytes: 5 * 1024 * 1024,
	/** Presigned upload session lifetime. */
	uploadTtlSeconds: 60 * 60,
	/** Deployments retained per project (unpinned). */
	retainedDeployments: 10,
	/** Soft-deleted project trash period. */
	trashDays: 7,
	/** Slug rename redirect lifetime. */
	redirectDays: 30,
} as const;

export const accessModes = ['public', 'password', 'platform', 'access'] as const;
export type AccessMode = (typeof accessModes)[number];

export const runtimes = ['static', 'process', 'container', 'function', 'compose'] as const;
export type Runtime = (typeof runtimes)[number];

/**
 * The four deploy levels shown in every surface (docs/COMPOSE.md). Tiers are a *product* view of
 * the runtime column: they never replace it, because a function runs on the level-2 machinery
 * (a sandboxed process with a managed manifest) while a compose stack runs several level-3
 * containers together.
 *
 * 1. static  — files served by Caddy from an immutable release
 * 2. process — one sandboxed Bun/Node unit (functions are the managed variant)
 * 3. container — one OCI image in a rootless Quadlet
 * 4. compose — a docker-compose file rendered as a private container group
 */
export const deployLevels = [1, 2, 3, 4] as const;
export type DeployLevel = (typeof deployLevels)[number];

/** The level a runtime belongs to. Functions share level 2's process machinery. */
export function deployLevelFor(runtime: Runtime): DeployLevel {
	if (runtime === 'static') return 1;
	if (runtime === 'process' || runtime === 'function') return 2;
	if (runtime === 'container') return 3;
	return 4;
}

export const deploymentStatuses = ['pending', 'active', 'inactive', 'failed', 'deleted'] as const;
export type DeploymentStatus = (typeof deploymentStatuses)[number];

export const nodeStatuses = ['pending', 'online', 'offline', 'draining'] as const;
export type NodeStatus = (typeof nodeStatuses)[number];

export type Placement = 'edge' | 'auto' | (string & {});
