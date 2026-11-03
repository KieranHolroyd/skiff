/**
 * Project slug rules (DESIGN §5.1, D32).
 *
 * Slugs are a global namespace because they become hostnames: `<slug>.<contentDomain>`
 * and `<slug>--<shortid>.<contentDomain>`. They must be 3–40 characters, lowercase
 * alphanumerics and hyphens, and may not contain `--`, which is the preview separator.
 */

export const SLUG_MIN = 3;
export const SLUG_MAX = 40;
export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

/** Never assignable: platform hostnames, common service names and our own path prefixes. */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
	'cloud', 'api', 'mcp', 'auth', 'www', 'admin', 'status', 'mail', 'login',
	'static', 'assets', 'cdn', 'control', 'preview', 'previews', 'staging',
	'skiff', 'skif', '_', '_skiff', 'well-known', 'internal', 'system', 'support', 'billing',
]);

export type SlugProblem = 'length' | 'characters' | 'double-hyphen' | 'reserved' | 'taken';

export interface SlugCheck {
	ok: boolean;
	problem?: SlugProblem;
	reason?: string;
}

export function checkSlug(slug: string, taken: Iterable<string> = []): SlugCheck {
	if (slug.length < SLUG_MIN || slug.length > SLUG_MAX)
		return { ok: false, problem: 'length', reason: `Slug must be ${SLUG_MIN}–${SLUG_MAX} characters.` };
	if (!SLUG_PATTERN.test(slug))
		return {
			ok: false,
			problem: 'characters',
			reason: 'Use lowercase letters, digits and single hyphens; start and end with a letter or digit.',
		};
	if (slug.includes('--'))
		return { ok: false, problem: 'double-hyphen', reason: 'Double hyphens are reserved for preview URLs.' };
	if (RESERVED_SLUGS.has(slug))
		return { ok: false, problem: 'reserved', reason: `"${slug}" is reserved by the platform.` };
	if (new Set(taken).has(slug)) return { ok: false, problem: 'taken', reason: `"${slug}" is already taken.` };
	return { ok: true };
}

const ADJECTIVES = ['swift', 'calm', 'bright', 'quiet', 'bold', 'lucky', 'north', 'amber', 'silver', 'green'];
const NOUNS = ['harbor', 'meadow', 'signal', 'ledger', 'beacon', 'garden', 'rocket', 'summit', 'river', 'forge'];

/** Deterministic suggestions from the requested slug, never a silent `-2`. */
export function suggestSlugs(slug: string, taken: Iterable<string> = [], count = 3): string[] {
	const takenSet = new Set(taken);
	const base = slug.replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').replace(/-+/g, '-') || 'site';
	const candidates: string[] = [];
	const suffixes = ['app', 'site', 'web', 'hq', 'io', 'dev'];
	for (const suffix of suffixes) candidates.push(trimSlug(`${base}-${suffix}`));
	let i = 0;
	while (candidates.length < count && i < ADJECTIVES.length * NOUNS.length) {
		candidates.push(trimSlug(`${base}-${ADJECTIVES[i % ADJECTIVES.length]}-${NOUNS[(i * 7) % NOUNS.length]}`));
		i++;
	}
	const out: string[] = [];
	for (const candidate of candidates) {
		if (out.length >= count) break;
		if (!checkSlug(candidate, takenSet).ok || takenSet.has(candidate)) continue;
		out.push(candidate);
	}
	return out;
}

function trimSlug(value: string): string {
	return value.slice(0, SLUG_MAX).replace(/-+$/g, '');
}
