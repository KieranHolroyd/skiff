import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * The platform registry's pull-through cache on a node (docs/REGISTRY.md G4).
 *
 * Podman tries `[[registry.mirror]]` entries before the upstream, and falls back to the upstream
 * when a mirror fails, so a broken registry slows pulls but never breaks them. The node logs in to
 * the mirror with its node login, merged into root's default auth file under the registry host
 * only; other entries in that file (an operator's own logins) are left alone. Workloads that carry
 * their own `--authfile` get a workload login that also covers the mirror repositories.
 */

export const MIRROR_UPSTREAMS = ['docker.io', 'ghcr.io', 'quay.io'] as const;
export type MirrorUpstream = (typeof MIRROR_UPSTREAMS)[number];
export const MIRROR_CONF_NAME = '50-yoal-mirror.conf';

export interface MirrorRequest {
	host: string;
	upstreams: MirrorUpstream[];
	username: string;
	password: string;
}

export class MirrorValidationError extends Error {}

const HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::[0-9]{1,5})?$/;

export function parseMirrorRequest(value: unknown): MirrorRequest {
	if (typeof value !== 'object' || value === null) throw new MirrorValidationError('request must be an object');
	const raw = value as Record<string, unknown>;
	const host = String(raw.host ?? '');
	if (!HOST_PATTERN.test(host) || host.length > 253) throw new MirrorValidationError('host must be a registry host');
	if (!Array.isArray(raw.upstreams) || raw.upstreams.some((u) => !(MIRROR_UPSTREAMS as readonly string[]).includes(u as string)))
		throw new MirrorValidationError(`upstreams must be values of ${MIRROR_UPSTREAMS.join(', ')}`);
	const upstreams = [...new Set(raw.upstreams as MirrorUpstream[])];
	const username = String(raw.username ?? '');
	const password = String(raw.password ?? '');
	if (upstreams.length > 0) {
		if (!/^[A-Za-z0-9._-]{1,128}$/.test(username)) throw new MirrorValidationError('username is not a registry login');
		if (!password || password.length > 4096 || /[\s\0]/.test(password)) throw new MirrorValidationError('password is not a registry password');
	}
	return { host, upstreams, username, password };
}

/** `containers-registries.conf(5)`: one `[[registry]]` per upstream, mirrored at `<host>/<upstream>`. */
export function renderMirrorConf(host: string, upstreams: readonly MirrorUpstream[]): string {
	const blocks = upstreams.map(
		(upstream) =>
			`[[registry]]\nprefix = "${upstream}"\nlocation = "${upstream}"\n\n[[registry.mirror]]\nlocation = "${host}/${upstream}"\n`,
	);
	return `# Written by the Yoal helper (docs/REGISTRY.md G4). Do not edit.\n\n${blocks.join('\n')}`;
}

async function writeAtomic(path: string, content: string, mode: number): Promise<void> {
	await fs.mkdir(dirname(path), { recursive: true, mode: 0o755 });
	const tmp = `${path}.tmp-${randomUUID()}`;
	await fs.writeFile(tmp, content, { mode });
	await fs.rename(tmp, path);
}

/** Apply (or, with no upstreams, remove) the mirror config and the node login. */
export async function applyMirror(
	request: MirrorRequest,
	paths: { confDir: string; authFile: string },
): Promise<{ upstreams: MirrorUpstream[]; changed: boolean }> {
	const confPath = join(paths.confDir, MIRROR_CONF_NAME);
	let changed = false;
	const before = await fs.readFile(confPath, 'utf8').catch(() => null);
	if (request.upstreams.length > 0) {
		const conf = renderMirrorConf(request.host, request.upstreams);
		if (before !== conf) {
			await writeAtomic(confPath, conf, 0o644);
			changed = true;
		}
	} else if (before !== null) {
		await fs.rm(confPath, { force: true });
		changed = true;
	}
	const auth = JSON.parse((await fs.readFile(paths.authFile, 'utf8').catch(() => '')) || '{}') as {
		auths?: Record<string, { auth?: string }>;
	};
	auth.auths ??= {};
	const encoded = Buffer.from(`${request.username}:${request.password}`).toString('base64');
	const current = auth.auths[request.host]?.auth;
	if (request.upstreams.length > 0 && current !== encoded) {
		auth.auths[request.host] = { auth: encoded };
		await writeAtomic(paths.authFile, `${JSON.stringify(auth, null, 2)}\n`, 0o600);
		changed = true;
	} else if (request.upstreams.length === 0 && current !== undefined) {
		delete auth.auths[request.host];
		await writeAtomic(paths.authFile, `${JSON.stringify(auth, null, 2)}\n`, 0o600);
		changed = true;
	}
	return { upstreams: request.upstreams, changed };
}
