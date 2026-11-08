import type { PipelineJobClaim } from '@skiff/contracts';
import { truthyInput } from './context.ts';

/**
 * Pure pieces of `skiff/build-image` (docs/PIPELINES.md §4.3, W6, W10, W11): input parsing, the
 * BuildKit cache scope and the `buildctl build` argv. The action in `actions.ts` does the I/O.
 */

export class ImageInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ImageInputError';
	}
}

/** Where `buildctl` and the BuildKit socket appear when the runner starts the sidecar (W6). */
export const BUILDKIT_BIN_DIR = '/skiff/bin';
export const BUILDKIT_DEFAULT_HOST = 'unix:///skiff/buildkit/buildkitd.sock';

export interface BuildSecret {
	id: string;
	value: string;
}

const SECRET_ID = /^[A-Za-z0-9_.-]{1,128}$/;

/**
 * `secrets:` lines are `id=VALUE` (the value is usually `${{ secrets.X }}`, already interpolated).
 * A value may span lines: a line without `id=` continues the previous secret, so a PEM key works.
 */
export function parseSecretInputs(text: string | undefined): BuildSecret[] {
	if (!text?.trim()) return [];
	const secrets: BuildSecret[] = [];
	for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
		const match = /^\s*([A-Za-z0-9_.-]{1,128})=(.*)$/.exec(line);
		if (match) {
			secrets.push({ id: match[1]!, value: match[2]! });
			continue;
		}
		if (!secrets.length) {
			if (line.trim()) throw new ImageInputError('secrets lines must be id=VALUE');
			continue;
		}
		secrets[secrets.length - 1]!.value += `\n${line}`;
	}
	for (const secret of secrets) secret.value = secret.value.replace(/\n+$/, '');
	const ids = new Set<string>();
	for (const secret of secrets) {
		if (ids.has(secret.id)) throw new ImageInputError(`Duplicate secret id "${secret.id}"`);
		ids.add(secret.id);
	}
	return secrets;
}

/** `secret-files:` lines are `id=path` (a file in the workspace or temp, e.g. written by a step). */
export function parseSecretFiles(lines: string[]): Array<{ id: string; path: string }> {
	return lines.map((line) => {
		const index = line.indexOf('=');
		const id = index > 0 ? line.slice(0, index).trim() : '';
		const path = index > 0 ? line.slice(index + 1).trim() : '';
		if (!SECRET_ID.test(id) || !path) throw new ImageInputError(`secret-files lines must be id=path (got "${line.slice(0, 40)}")`);
		return { id, path };
	});
}

/** `build-args` lines: KEY=VALUE, never carrying a secret value (W11: secrets go in as mounts). */
export function checkBuildArgs(lines: string[], containsSecret: (text: string) => boolean, secrets: BuildSecret[]): string[] {
	for (const arg of lines) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) throw new ImageInputError(`build-args lines must be KEY=VALUE (got "${arg.slice(0, 40)}")`);
		const value = arg.slice(arg.indexOf('=') + 1);
		if (containsSecret(arg) || secrets.some((secret) => secret.value && value === secret.value))
			throw new ImageInputError(`build-args must not contain secrets (${arg.slice(0, arg.indexOf('='))}); pass them with secrets: id=VALUE and RUN --mount=type=secret`);
	}
	return lines;
}

/** `labels:` lines: KEY=VALUE. */
export function checkLabels(lines: string[]): string[] {
	for (const label of lines) if (!/^[^=\s]+=/.test(label)) throw new ImageInputError(`labels lines must be KEY=VALUE (got "${label.slice(0, 40)}")`);
	return lines;
}

export interface Attestations {
	provenance: 'min' | 'max' | null;
	sbom: boolean;
}

/**
 * `provenance:` (`min` default when pushing; `max` opt-in because it records build args; `false`
 * off) and `sbom:` (on by default when pushing).
 */
export function attestationInputs(inputs: Record<string, string | undefined>, push: boolean): Attestations {
	const raw = inputs.provenance?.trim().toLowerCase().replace(/^mode=/, '') ?? '';
	let provenance: Attestations['provenance'];
	if (!raw) provenance = push ? 'min' : null;
	else if (raw === 'min' || raw === 'max') provenance = raw;
	else if (['true', '1', 'yes', 'on'].includes(raw)) provenance = 'min';
	else if (['false', '0', 'no', 'off'].includes(raw)) provenance = null;
	else throw new ImageInputError(`provenance must be min, max or false (got "${raw}")`);
	return { provenance, sbom: truthyInput(inputs.sbom, push) };
}

/** `platforms:` → `linux/arm64[,linux/amd64]`, or null for this job's own architecture (`native`). */
export function platformInput(value: string | undefined): string | null {
	const list = (value ?? '')
		.split(/[\s,]+/)
		.map((entry) => entry.trim())
		.filter(Boolean);
	if (!list.length || (list.length === 1 && list[0] === 'native')) return null;
	for (const platform of list) if (!/^[a-z0-9]+\/[a-z0-9_]+(\/[a-z0-9]+)?$/.test(platform)) throw new ImageInputError(`Invalid platform "${platform}" (e.g. linux/arm64)`);
	return list.join(',');
}

/** A cache scope as a tag suffix: `[A-Za-z0-9_.-]`, at most 100 characters. */
export function sanitizeCacheScope(scope: string): string {
	const cleaned = scope
		.replace(/[^A-Za-z0-9_.-]+/g, '-')
		.replace(/^[-.]+|-+$/g, '')
		.slice(0, 100);
	return cleaned || 'default';
}

/**
 * W10: never shared between trusted and untrusted runs. `SKIFF_CACHE_SCOPE`, else the claim's
 * `buildkitCacheScope`, else `trusted` / `untrusted:<ref>`.
 */
export function buildkitCacheScope(claim: Pick<PipelineJobClaim, 'trust' | 'checkout' | 'buildkitCacheScope'>, env: Record<string, string | undefined>): string {
	const raw = env.SKIFF_CACHE_SCOPE?.trim() || claim.buildkitCacheScope?.trim() || (claim.trust === 'trusted' ? 'trusted' : `untrusted:${claim.checkout.ref}`);
	// An untrusted run can never name its way into the trusted scope.
	const scope = claim.trust === 'untrusted' && !raw.startsWith('untrusted') ? `untrusted:${raw}` : raw;
	return sanitizeCacheScope(scope);
}

export interface BuildctlOptions {
	context: string;
	dockerfileDir: string;
	filename: string;
	tags: string[];
	push: boolean;
	target: string | null;
	platform: string | null;
	buildArgs: string[];
	labels: string[];
	secrets: Array<{ id: string; src: string }>;
	attestations: Attestations;
	cache: { importRefs: string[]; exportRef: string | null };
	metadataFile: string;
	/** Push over plain HTTP (a localhost registry). */
	insecure?: boolean;
}

/** `buildctl build` with the dockerfile frontend. */
export function buildctlArgs(options: BuildctlOptions): string[] {
	const args = [
		'build',
		'--frontend',
		'dockerfile.v0',
		'--local',
		`context=${options.context}`,
		'--local',
		`dockerfile=${options.dockerfileDir}`,
		'--opt',
		`filename=${options.filename}`,
	];
	if (options.target) args.push('--opt', `target=${options.target}`);
	if (options.platform) args.push('--opt', `platform=${options.platform}`);
	for (const arg of options.buildArgs) args.push('--opt', `build-arg:${arg}`);
	for (const label of options.labels) args.push('--opt', `label:${label}`);
	for (const secret of options.secrets) args.push('--secret', `id=${secret.id},src=${secret.src}`);
	if (options.attestations.provenance) args.push('--opt', `attest:provenance=mode=${options.attestations.provenance}`);
	if (options.attestations.sbom) args.push('--opt', 'attest:sbom=');
	for (const ref of options.cache.importRefs) args.push('--import-cache', `type=registry,ref=${ref}`);
	if (options.cache.exportRef) args.push('--export-cache', `type=registry,ref=${options.cache.exportRef},mode=max`);
	// CSV: a name list with commas must be quoted as one field.
	const output = [`type=image`, `"name=${options.tags.join(',')}"`, `push=${options.push}`];
	if (options.insecure && options.push) output.push('registry.insecure=true');
	args.push('--output', output.join(','), '--metadata-file', options.metadataFile);
	return args;
}
