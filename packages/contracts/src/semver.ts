/**
 * Semantic Versioning 2.0.0 (https://semver.org) for the platform `VERSION` file.
 *
 * Dependency-free and runtime-neutral: the control plane (Bun), the self-updater (Bun) and the
 * CLI (Node) all import it.
 */

export interface SemVer {
	major: number;
	minor: number;
	patch: number;
	prerelease: ReadonlyArray<string | number>;
	build: ReadonlyArray<string>;
	/** Canonical form without a leading `v` or build metadata, e.g. `1.4.0-rc.1`. */
	version: string;
}

// The official regex from semver.org, anchored. Numeric identifiers have no leading zeros.
const SEMVER =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** Parse `1.2.3`, `v1.2.3-rc.1+build.5` or a VERSION file body. Returns null when invalid. */
export function parseSemver(input: string | null | undefined): SemVer | null {
	if (typeof input !== 'string') return null;
	const text = input.trim().replace(/^v/, '');
	if (text.length > 256) return null;
	const match = SEMVER.exec(text);
	if (!match) return null;
	const [major, minor, patch] = [match[1], match[2], match[3]].map(Number) as [number, number, number];
	if (![major, minor, patch].every(Number.isSafeInteger)) return null;
	const prerelease = match[4]
		? match[4].split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id))
		: [];
	const build = match[5] ? match[5].split('.') : [];
	const core = `${major}.${minor}.${patch}`;
	return {
		major,
		minor,
		patch,
		prerelease,
		build,
		version: prerelease.length ? `${core}-${prerelease.join('.')}` : core,
	};
}

/** True when `input` is a valid semantic version (a leading `v` is tolerated). */
export function isSemver(input: string | null | undefined): boolean {
	return parseSemver(input) !== null;
}

/**
 * Semver precedence: negative if a < b, 0 if equal, positive if a > b. Build metadata is ignored
 * and a prerelease sorts before its release (`1.0.0-rc.1 < 1.0.0`). Throws on invalid input.
 */
export function compareSemver(a: string | SemVer, b: string | SemVer): number {
	const left = typeof a === 'string' ? parseSemver(a) : a;
	const right = typeof b === 'string' ? parseSemver(b) : b;
	if (!left) throw new TypeError(`Invalid semantic version: ${String(a)}`);
	if (!right) throw new TypeError(`Invalid semantic version: ${String(b)}`);
	for (const key of ['major', 'minor', 'patch'] as const) {
		if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
	}
	const lp = left.prerelease;
	const rp = right.prerelease;
	if (lp.length === 0 || rp.length === 0) return lp.length === rp.length ? 0 : lp.length === 0 ? 1 : -1;
	for (let i = 0; i < Math.max(lp.length, rp.length); i++) {
		const x = lp[i];
		const y = rp[i];
		if (x === undefined) return -1;
		if (y === undefined) return 1;
		if (x === y) continue;
		if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1;
		if (typeof x === 'number') return -1;
		if (typeof y === 'number') return 1;
		return x < y ? -1 : 1;
	}
	return 0;
}

/** The kind of change from `from` to `to`, for wording ("minor update"). Null if not newer. */
export function semverBump(from: string, to: string): 'major' | 'minor' | 'patch' | 'prerelease' | null {
	const a = parseSemver(from);
	const b = parseSemver(to);
	if (!a || !b || compareSemver(b, a) <= 0) return null;
	if (b.major !== a.major) return 'major';
	if (b.minor !== a.minor) return 'minor';
	if (b.patch !== a.patch) return 'patch';
	return 'prerelease';
}

export type SemverBump = 'major' | 'minor' | 'patch';

/**
 * The next version, with npm `semver.inc` semantics: build metadata is dropped, and a prerelease
 * graduates to its release when that is the requested bump (`1.2.0-rc.1` minor → `1.2.0`,
 * `1.2.3-rc.1` patch → `1.2.3`, `2.0.0-rc.1` major → `2.0.0`). Throws on invalid input.
 */
export function bumpSemver(version: string, kind: SemverBump): string {
	const v = parseSemver(version);
	if (!v) throw new TypeError(`Invalid semantic version: ${version}`);
	const pre = v.prerelease.length > 0;
	switch (kind) {
		case 'major':
			return pre && v.minor === 0 && v.patch === 0 ? `${v.major}.0.0` : `${v.major + 1}.0.0`;
		case 'minor':
			return pre && v.patch === 0 ? `${v.major}.${v.minor}.0` : `${v.major}.${v.minor + 1}.0`;
		case 'patch':
			return pre ? `${v.major}.${v.minor}.${v.patch}` : `${v.major}.${v.minor}.${v.patch + 1}`;
	}
}
