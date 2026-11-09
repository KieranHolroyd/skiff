/**
 * Project selectors for bulk commands. The server only ever acts on an explicit list of slugs
 * (D50), so `--match`, `--not-deployed`, `--older-than` and `--stdin` are resolved here, against
 * the project list, into that list. The plan the server returns is what the human confirms.
 */
import { UsageError } from './errors.ts';

/** Mirrors `operationLimits.bulkTargets` in @yoal/contracts. Keep in sync. */
export const MAX_BULK_TARGETS = 100;

const durationUnits: Record<string, number> = {
	s: 1000,
	m: 60 * 1000,
	h: 60 * 60 * 1000,
	d: 24 * 60 * 60 * 1000,
	w: 7 * 24 * 60 * 60 * 1000,
};

/** `30d`, `12h`, `2w`, `90m`, `45s`, or combinations like `1w2d`. Returns milliseconds. */
export function parseDuration(value: string): number {
	const input = value.trim().toLowerCase();
	if (!/^(\d+[smhdw])+$/.test(input))
		throw new UsageError(`"${value}" is not a duration. Use a number and a unit, e.g. 30d, 12h, 2w (units: s m h d w).`);
	let total = 0;
	for (const [, amount, unit] of input.matchAll(/(\d+)([smhdw])/g)) total += Number(amount) * durationUnits[unit!]!;
	if (total <= 0) throw new UsageError(`--older-than must be longer than zero (got "${value}").`);
	return total;
}

/**
 * Shell-style glob matched against a whole slug: `*` any run, `?` one character, `[abc]` /
 * `[a-z]` / `[!abc]` a class. Everything else is literal.
 */
export function globToRegExp(glob: string): RegExp {
	let source = '';
	for (let i = 0; i < glob.length; i++) {
		const char = glob[i]!;
		if (char === '*') source += '.*';
		else if (char === '?') source += '.';
		else if (char === '[') {
			const close = glob.indexOf(']', i + 2);
			if (close === -1) {
				source += '\\[';
				continue;
			}
			let body = glob.slice(i + 1, close);
			const negate = body.startsWith('!') || body.startsWith('^');
			if (negate) body = body.slice(1);
			source += `[${negate ? '^' : ''}${body.replace(/[\\\]^]/g, '\\$&')}]`;
			i = close;
		} else source += char.replace(/[.+^${}()|\\/]/g, '\\$&');
	}
	return new RegExp(`^${source}$`);
}

/** Newline-separated slugs from stdin. Blank lines and `#` comments are ignored. */
export function parseSlugList(text: string): string[] {
	return text
		.split(/\r?\n/)
		.map((line) => line.replace(/#.*$/, '').trim())
		.filter((line) => line.length > 0);
}

export interface SelectableProject {
	slug: string;
	productionDeploymentId?: string | null;
	createdAt?: string;
	deletedAt?: string | null;
}

export interface SelectorOptions {
	/** Slugs named on the command line or read from stdin. Kept even if unknown: the plan says `not_found`. */
	explicit: string[];
	match?: string;
	notDeployed?: boolean;
	/** Milliseconds; compared with `ageField`. */
	olderThanMs?: number;
	/** `createdAt` for live projects, `deletedAt` in the trash. */
	ageField: 'createdAt' | 'deletedAt';
	now: number;
}

export function hasSelectors(options: Pick<SelectorOptions, 'match' | 'notDeployed' | 'olderThanMs'>): boolean {
	return options.match !== undefined || options.notDeployed === true || options.olderThanMs !== undefined;
}

/**
 * Explicit slugs first (in order), then every project matching all of the selectors. Duplicates
 * are dropped. Selectors combine with AND; the explicit list is a union on top.
 */
export function resolveTargets(projects: SelectableProject[], options: SelectorOptions): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	const add = (slug: string) => {
		if (seen.has(slug)) return;
		seen.add(slug);
		out.push(slug);
	};
	for (const slug of options.explicit) add(slug);
	if (!hasSelectors(options)) return out;

	const pattern = options.match !== undefined ? globToRegExp(options.match) : undefined;
	const cutoff = options.olderThanMs !== undefined ? options.now - options.olderThanMs : undefined;
	for (const project of projects) {
		if (pattern && !pattern.test(project.slug)) continue;
		if (options.notDeployed && project.productionDeploymentId) continue;
		if (cutoff !== undefined) {
			const at = Date.parse(project[options.ageField] ?? '');
			if (!Number.isFinite(at) || at > cutoff) continue;
		}
		add(project.slug);
	}
	return out;
}

/** Turn a resolved list into a clear error when it's empty or over the server's cap. */
export function assertTargetCount(targets: string[], context: { usedSelectors: boolean; where: string }): void {
	if (targets.length === 0) {
		throw new UsageError(
			context.usedSelectors
				? `No projects${context.where ? ` ${context.where}` : ''} matched the selectors. Nothing to do.`
				: 'Name at least one project, or select some with --match, --not-deployed, --older-than or --stdin.',
		);
	}
	if (targets.length > MAX_BULK_TARGETS) {
		throw new UsageError(
			`${targets.length} projects matched, but one operation takes at most ${MAX_BULK_TARGETS}. ` +
				'Narrow the selection (a tighter --match, --older-than or --not-deployed) and run it again for the rest.',
		);
	}
}
