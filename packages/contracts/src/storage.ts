import * as z from 'zod';

/**
 * Where a node keeps its data (D48). A platform admin picks the paths in the dashboard; the
 * agent asks the root `yoal-storage.service` on the node to apply them, and that service
 * re-reads the paths from the control plane and checks them with these same rules before it
 * moves anything. A compromised agent therefore cannot choose a path itself.
 */

/** What a fresh install uses. `null` in the node settings means "use this". */
export const NODE_STORAGE_DEFAULTS = {
	/** Agent state and release cache (`releases/`, `sites/`, desired-state cache). Caddy serves from here. */
	dataDir: '/var/lib/yoal/agent',
	/** Builder scratch: one checkout per running build. */
	buildDir: '/var/lib/yoal-builder',
} as const;

export type NodeStorageKey = keyof typeof NODE_STORAGE_DEFAULTS;

/**
 * Paths that must never hold node data, nor contain it: system trees, other Yoal state,
 * volatile mounts, and home directories (hidden from the sandboxed services).
 */
const FORBIDDEN_PREFIXES = [
	'/bin',
	'/boot',
	'/dev',
	'/etc',
	'/home',
	'/lib',
	'/lib32',
	'/lib64',
	'/libx32',
	'/opt/yoal',
	'/proc',
	'/root',
	'/run',
	'/sbin',
	'/snap',
	'/sys',
	'/tmp',
	'/usr',
	'/var/lib/yoal/data',
	'/var/lib/yoal/backups',
	'/var/lib/yoal/caddy',
	'/var/log',
	'/var/tmp',
];

/** Too broad to own: a move would chown or delete everything beside the data. */
const FORBIDDEN_EXACT = ['/', '/data', '/media', '/mnt', '/opt', '/srv', '/var', '/var/lib', '/var/lib/yoal', '/srv/yoal'];

function within(path: string, prefix: string): boolean {
	return path === prefix || path.startsWith(`${prefix}/`);
}

/** Why `path` is not an acceptable storage directory, or null when it is. */
export function storagePathProblem(path: string): string | null {
	if (!path.startsWith('/')) return 'Use an absolute path, such as /mnt/data/yoal.';
	if (path.length > 200) return 'Keep the path under 200 characters.';
	if (!/^[A-Za-z0-9._/-]+$/.test(path)) return 'Use only letters, digits, ".", "_", "-" and "/".';
	if (path !== '/' && path.endsWith('/')) return 'Drop the trailing slash.';
	if (path.split('/').some((part, index) => (index > 0 && part === '') || part === '.' || part === '..'))
		return 'Use a normalized path, without "//", "." or "..".';
	if (FORBIDDEN_EXACT.includes(path)) return `${path} is too broad; use a directory inside it, such as ${path === '/' ? '/mnt/data' : path}/yoal.`;
	const prefix = FORBIDDEN_PREFIXES.find((candidate) => within(path, candidate));
	if (prefix) return `${path} is inside ${prefix}, which cannot hold node data.`;
	return null;
}

export const nodeStoragePathSchema = z
	.string()
	.trim()
	.superRefine((value, ctx) => {
		const problem = storagePathProblem(value);
		if (problem) ctx.addIssue({ code: 'custom', message: problem });
	});

/** Requested paths; `null` keeps the install default. */
export const nodeStorageSchema = z.object({
	dataDir: nodeStoragePathSchema.nullable().default(null),
	buildDir: nodeStoragePathSchema.nullable().default(null),
});
export type NodeStorage = z.infer<typeof nodeStorageSchema>;

export const nodeStorageStates = ['applied', 'pending', 'failed'] as const;
export type NodeStorageState = (typeof nodeStorageStates)[number];

/**
 * What `yoal-storage.service` last did, written to `/etc/yoal/storage.json` on the node and
 * relayed by the agent's heartbeat. `requested` is the setting it acted on; the paths are what is
 * in effect now.
 */
export const nodeStorageStatusSchema = z.object({
	requested: z.object({ dataDir: z.string().nullable(), buildDir: z.string().nullable() }),
	dataDir: z.string().max(200),
	buildDir: z.string().max(200),
	status: z.enum(nodeStorageStates),
	message: z.string().max(2000).nullable().default(null),
	updatedAt: z.string().max(40),
});
export type NodeStorageStatus = z.infer<typeof nodeStorageStatusSchema>;

/** Whether the node still has to act on `desired` (the applier records what it acted on). */
export function storageNeedsApply(desired: NodeStorage, status: NodeStorageStatus | null): boolean {
	if (!status) return desired.dataDir !== null || desired.buildDir !== null;
	if (status.status === 'pending') return true;
	return status.requested.dataDir !== desired.dataDir || status.requested.buildDir !== desired.buildDir;
}
