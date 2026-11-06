import type { DashboardVariable, QueryVariables } from '@skiff/contracts';
import type { TimeRange } from './time.js';

/** The "All" selection, as stored in `current`. */
export const ALL = '$__all';

/** `a, b, c` → `['a', 'b', 'c']`. */
export function customOptions(variable: Pick<DashboardVariable, 'custom'>): string[] {
	return [
		...new Set(
			variable.custom
				.split(',')
				.map((item) => item.trim())
				.filter(Boolean)
		)
	];
}

/**
 * The values each variable stands for in a query; a single-value variable is a string. "All" is
 * `['$__all', ...every known option]`: builder filters treat the marker as "no filter" on the
 * server, and SQL `IN $var` still gets the real values (the marker matches nothing).
 */
export function variableValues(
	variables: DashboardVariable[],
	options: Record<string, string[] | undefined>
): QueryVariables {
	const out: QueryVariables = {};
	for (const variable of variables) {
		const current = variable.current ?? [];
		if (variable.kind === 'textbox') {
			out[variable.name] = current[0] ?? '';
			continue;
		}
		const known = variable.kind === 'custom' ? customOptions(variable) : options[variable.name];
		if (current.includes(ALL) || (current.length === 0 && variable.includeAll)) {
			out[variable.name] = [ALL, ...(known ?? [])];
			continue;
		}
		const picked = current.length > 0 ? current : (known?.slice(0, 1) ?? []);
		out[variable.name] = variable.multi ? picked : (picked[0] ?? '');
	}
	return out;
}

/** `$name` / `${name}` in titles and text, replaced by the values (joined with `, `). */
export function interpolate(text: string, values: QueryVariables): string {
	if (!text.includes('$')) return text;
	return text.replace(/\$\{([a-z][a-z0-9_]*)\}|\$([a-z][a-z0-9_]*)/g, (match, braced, bare) => {
		const value = values[(braced ?? bare) as string];
		if (value === undefined) return match;
		const list = Array.isArray(value) ? value : [value];
		return list.includes(ALL) ? 'All' : list.join(', ');
	});
}

export interface UrlState {
	range: TimeRange | null;
	refresh: string | null | undefined;
	vars: Record<string, string[]>;
}

/** `?from=now-24h&to=now&refresh=1m&var-host=a&var-host=b` → state. */
export function readUrlState(params: URLSearchParams): UrlState {
	const from = params.get('from');
	const to = params.get('to');
	const vars: Record<string, string[]> = {};
	for (const [key, value] of params) {
		if (!key.startsWith('var-')) continue;
		const name = key.slice(4);
		(vars[name] ??= []).push(value);
	}
	const refresh = params.has('refresh') ? params.get('refresh') || null : undefined;
	return { range: from && to ? { from, to } : null, refresh, vars };
}

/** The query string for the current view; other params on the URL are kept. */
export function writeUrlState(
	params: URLSearchParams,
	state: { range: TimeRange; refresh: string | null; variables: DashboardVariable[] }
): URLSearchParams {
	const next = new URLSearchParams(params);
	for (const key of [...next.keys()]) if (key.startsWith('var-')) next.delete(key);
	next.set('from', state.range.from);
	next.set('to', state.range.to);
	if (state.refresh) next.set('refresh', state.refresh);
	else next.delete('refresh');
	for (const variable of state.variables) {
		for (const value of variable.current ?? []) next.append(`var-${variable.name}`, value);
	}
	return next;
}
