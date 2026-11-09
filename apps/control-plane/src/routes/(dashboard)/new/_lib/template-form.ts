import {
	buildAppTemplate,
	deriveSlug,
	templateSecretSuffix,
	type AppTemplateView,
	type TemplateField,
	type TemplateGroup,
	type TemplatePlan
} from '@yoal/contracts';

/**
 * The template form's state and rules, kept pure so they are testable and so the page stays a
 * renderer. Everything is driven by the template's field list (plan 21: a new catalog entry needs
 * no dashboard change), and validation runs the template's own `build`, the same function the
 * server runs, so the live plan is the plan that will be created.
 */

/** Keys the dashboard renders itself because every template's project has them. */
export const BUILT_IN_KEYS = ['slug', 'placement'] as const;

export interface TemplateFormState {
	/** Raw input per field key, as typed. Labels are comma-joined. */
	values: Record<string, string>;
	/** Fields with `replaces` that are switched on (their replaced fields are hidden). */
	alternatives: Record<string, boolean>;
	slug: string;
	placement: string;
}

export interface FormGroup extends TemplateGroup {
	fields: TemplateField[];
}

const DEFAULT_GROUP: TemplateGroup = { id: 'configuration', title: 'Configuration' };

export function initialState(template: AppTemplateView): TemplateFormState {
	const values: Record<string, string> = {};
	for (const field of template.fields) {
		if (field.default !== undefined) values[field.key] = String(field.default);
		else if (field.kind === 'select') values[field.key] = field.options?.[0]?.value ?? '';
		else values[field.key] = '';
	}
	return { values, alternatives: {}, slug: '', placement: 'auto' };
}

/** The template's groups in order, each with its fields; empty groups are dropped. */
export function formGroups(template: AppTemplateView): FormGroup[] {
	const declared = template.groups ?? [];
	const known = new Set(declared.map((group) => group.id));
	const groups: FormGroup[] = declared.map((group) => ({ ...group, fields: [] }));
	let fallback: FormGroup | undefined;
	for (const field of template.fields) {
		const target =
			field.group && known.has(field.group)
				? groups.find((group) => group.id === field.group)
				: (fallback ??= { ...DEFAULT_GROUP, fields: [] });
		target!.fields.push(field);
	}
	if (fallback) {
		// Ungrouped fields sit before any advanced group.
		const at = groups.findIndex((group) => group.advanced);
		groups.splice(at === -1 ? groups.length : at, 0, fallback);
	}
	return groups.filter((group) => group.fields.length > 0);
}

/** The field (if any) whose `replaces` names `key`. */
function replacerOf(template: AppTemplateView, key: string): TemplateField | undefined {
	return template.fields.find((field) => field.replaces?.includes(key));
}

export function isVisible(
	template: AppTemplateView,
	field: TemplateField,
	state: TemplateFormState
): boolean {
	if (field.showWhen && state.values[field.showWhen.key] !== field.showWhen.equals) return false;
	if (field.replaces) return state.alternatives[field.key] === true;
	const replacer = replacerOf(template, field.key);
	if (replacer && state.alternatives[replacer.key]) return false;
	return true;
}

/**
 * A replacing field is offered (as a switch) only while at least one of the fields it replaces
 * would otherwise be shown, so the switch never appears with nothing to swap.
 */
export function isOffered(
	template: AppTemplateView,
	field: TemplateField,
	state: TemplateFormState
): boolean {
	if (!field.replaces) return isVisible(template, field, state);
	if (field.showWhen && state.values[field.showWhen.key] !== field.showWhen.equals) return false;
	return field.replaces.some((key) => {
		const replaced = template.fields.find((candidate) => candidate.key === key);
		if (!replaced) return false;
		return !replaced.showWhen || state.values[replaced.showWhen.key] === replaced.showWhen.equals;
	});
}

/** Values the form submits: visible fields only, trimmed (a PEM keeps its line breaks). */
export function collectValues(
	template: AppTemplateView,
	state: TemplateFormState
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const field of template.fields) {
		if (!isVisible(template, field, state)) continue;
		const raw = String(state.values[field.key] ?? '');
		const value = field.kind === 'textarea' ? raw : raw.trim();
		if (value.trim() !== '') out[field.key] = value;
	}
	const slug = state.slug.trim();
	if (slug) out.slug = slug;
	out.placement = state.placement || 'auto';
	return out;
}

/** The slug the project will get: the typed one, or the one derived from the name. */
export function effectiveSlug(template: AppTemplateView, state: TemplateFormState): string {
	const typed = state.slug.trim();
	if (typed) return typed;
	const nameField = template.fields.find((field) => field.key === 'name');
	const name = nameField ? (state.values.name ?? '').trim() : '';
	return name ? deriveSlug(name) : '';
}

export interface Validation {
	plan: TemplatePlan | null;
	/** First problem per field key (template fields and built-ins). */
	issues: Record<string, string>;
	/** Problems that belong to no rendered field. */
	general: string[];
}

interface IssueLike {
	path: PropertyKey[];
	message: string;
}

function isIssueList(error: unknown): error is { issues: IssueLike[] } {
	return (
		typeof error === 'object' &&
		error !== null &&
		Array.isArray((error as { issues?: unknown }).issues)
	);
}

/**
 * Run the template's build on the current values and map any problems back onto fields. Empty
 * required fields are flagged up front: a schema's cross-field checks only run once its basic
 * checks pass, so without this a section could look finished and then fail later.
 */
export function validate(template: AppTemplateView, state: TemplateFormState): Validation {
	const result = buildAndMap(template, state);
	const values = collectValues(template, state);
	for (const field of template.fields) {
		if (!field.required || values[field.key] !== undefined || result.issues[field.key]) continue;
		if (isVisible(template, field, state)) result.issues[field.key] = 'Required.';
	}
	if (Object.keys(result.issues).length > 0) result.plan = null;
	return result;
}

function buildAndMap(template: AppTemplateView, state: TemplateFormState): Validation {
	const values = collectValues(template, state);
	const slug = effectiveSlug(template, state);
	try {
		const plan = buildAppTemplate(
			template.id,
			values,
			slug ? { secretSuffix: templateSecretSuffix(slug) } : {}
		);
		return { plan, issues: {}, general: [] };
	} catch (error) {
		if (!isIssueList(error)) {
			return { plan: null, issues: {}, general: ['The template could not be checked.'] };
		}
		const issues: Record<string, string> = {};
		const general: string[] = [];
		for (const issue of error.issues) {
			const head = issue.path[0];
			let key = typeof head === 'string' ? head : '';
			const field = template.fields.find((candidate) => candidate.key === key);
			// A problem on a field the user swapped out belongs to the field they are using.
			if (field && !isVisible(template, field, state)) {
				const replacer = replacerOf(template, key);
				if (replacer && isVisible(template, replacer, state)) key = replacer.key;
				else key = '';
			}
			const rendered =
				(key && template.fields.some((candidate) => candidate.key === key)) ||
				(BUILT_IN_KEYS as readonly string[]).includes(key);
			if (!rendered) {
				general.push(issue.message);
				continue;
			}
			if (issues[key]) continue;
			issues[key] = values[key] === undefined && key !== 'placement' ? 'Required.' : issue.message;
		}
		return { plan: null, issues, general };
	}
}

/** Fields whose values are credentials: never echoed into snippets or summaries. */
export function isCredential(template: AppTemplateView, field: TemplateField): boolean {
	return field.kind === 'secret' || replacerOf(template, field.key) !== undefined;
}

/** `2048` → `2 GB`, `1536` → `1.5 GB`, `512` → `512 MB`. */
export function formatMb(mb: number): string {
	if (mb < 1024) return `${mb} MB`;
	const gb = mb / 1024;
	return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
}

export function formatUnit(value: number, unit: string | undefined): string {
	if (unit === 'MB') return formatMb(value);
	if (!unit) return String(value);
	return `${value} ${unit}`;
}

/**
 * The REST request that does the same thing, for scripts and CI. Credentials are left out (with a
 * pointer to `existingSecret`-style fields) so the snippet is safe to copy into shell history.
 */
export function apiSnippet(
	template: AppTemplateView,
	state: TemplateFormState,
	origin: string
): string {
	const values = collectValues(template, state);
	const body: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(values)) {
		const field = template.fields.find((candidate) => candidate.key === key);
		if (field && isCredential(template, field)) continue;
		body[key] = field?.kind === 'number' && Number.isFinite(Number(value)) ? Number(value) : value;
	}
	const json = JSON.stringify({ values: body }).replace(/'/g, `'\\''`);
	return [
		`curl -X POST ${origin}/api/v1/templates/${template.id} \\`,
		`  -H "Authorization: Bearer $YOAL_TOKEN" \\`,
		`  -H 'content-type: application/json' \\`,
		`  -d '${json}'`
	].join('\n');
}

export interface CapacityLike {
	nodeId: string;
	name: string;
	mode: string;
	status: string;
	freeMemoryMb: number;
}

/**
 * Where `auto` would put a workload right now, mirroring `resolvePlacement` in core: the online
 * worker with the most free budget that fits, else the edge if it fits. Only a preview: the real
 * choice is made once, at deploy time.
 */
export function predictAuto<T extends CapacityLike>(capacity: T[], memoryMb: number): T | null {
	const online = capacity.filter((node) => node.status === 'online');
	const worker = online
		.filter((node) => node.mode !== 'edge' && node.freeMemoryMb >= memoryMb)
		.sort((a, b) => b.freeMemoryMb - a.freeMemoryMb || a.name.localeCompare(b.name))[0];
	if (worker) return worker;
	const edge = online.find((node) => node.mode === 'edge');
	return edge && edge.freeMemoryMb >= memoryMb ? edge : null;
}

/** The memory admission reserves for a plan: per-replica memory times replicas. */
export function reservedMb(plan: TemplatePlan): number {
	return plan.spec.memoryMb * (plan.spec.replicas ?? 1);
}
