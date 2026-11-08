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

export const runtimes = ['static', 'process', 'container', 'function'] as const;
export type Runtime = (typeof runtimes)[number];

export const deploymentStatuses = ['pending', 'active', 'inactive', 'failed', 'deleted'] as const;
export type DeploymentStatus = (typeof deploymentStatuses)[number];

export const nodeStatuses = ['pending', 'online', 'offline', 'draining'] as const;
export type NodeStatus = (typeof nodeStatuses)[number];

export type Placement = 'edge' | 'auto' | (string & {});
