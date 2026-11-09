import type { BuilderSpec } from '@yoal/contracts';

/**
 * "Edit as SQL": the builder's SQL (as the server ran it) rewritten to run on its own as a SQL
 * panel. The server binds the range, the caller's tenancy scope and filter values as query
 * parameters; here the range becomes `$__timeFilter(bucket)`, the bucket width
 * `$__timeInterval(bucket)`, the scope clause is dropped (SQL panels are admin-only and see every
 * org) and filter parameters become literals or `$variables`.
 */
export function builderSqlToMacros(sql: string, builder: BuilderSpec): string {
	let out = sql
		.replace(/(\w+) >= \{from:[^}]+\} AND \1 <= \{to:[^}]+\}/g, '$__timeFilter($1)')
		.replace(/toStartOfInterval\((\w+), INTERVAL \d+ SECOND\)/g, '$__timeInterval($1)')
		.replace(/ AND \w+ IN \{scope:[^}]+\}/g, '')
		.replace(/\w+ IN \{scope:[^}]+\} AND /g, '');
	out = out.replace(/\{f(\d+):([^}]+)\}/g, (whole, index: string) => {
		const filter = builder.filters[Number(index)];
		if (!filter) return whole;
		return literal(filter.value);
	});
	return out;
}

function quote(value: string): string {
	return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function literal(value: BuilderSpec['filters'][number]['value']): string {
	if (typeof value === 'number') return String(value);
	if (Array.isArray(value)) return `(${value.map(quote).join(', ') || "''"})`;
	// A whole-value variable stays a variable; the server expands it in SQL too.
	if (/^\$\{?[a-z][a-z0-9_]*\}?$/.test(value)) return value;
	return quote(value);
}
