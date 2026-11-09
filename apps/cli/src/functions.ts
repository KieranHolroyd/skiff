/**
 * Function test tools (D124): pure parsing and formatting for `yoal function invoke` and
 * `yoal function cron`. The requests run on the function's node, so they bypass Caddy and domains.
 */
import { formatMs } from './brokers.ts';
import { UsageError } from './errors.ts';
import { FUNCTION_REQUEST_METHODS, type FunctionInvokeResult, type FunctionScheduledResult } from './node-tasks.ts';
import { formatBytes } from './output.ts';

/** `-H 'Name: value'` flags as a header map. Repeated names join with `, ` as HTTP allows. */
export function parseHeaderFlags(values: string[]): Record<string, string> {
	const headers: Record<string, string> = {};
	const names = new Map<string, string>();
	for (const raw of values) {
		const colon = raw.indexOf(':');
		const name = colon === -1 ? '' : raw.slice(0, colon).trim();
		if (!name || /[\s()<>@,;:\\"/[\]?={}]/.test(name))
			throw new UsageError(`-H expects 'Name: value', got "${raw}".`);
		const value = raw.slice(colon + 1).trim();
		const key = names.get(name.toLowerCase());
		if (key === undefined) {
			names.set(name.toLowerCase(), name);
			headers[name] = value;
		} else headers[key] = `${headers[key]}, ${value}`;
	}
	return headers;
}

/** `-X`: upper-cased; the server accepts a fixed set. */
export function parseMethod(value: string | undefined, hasBody: boolean): string {
	if (value === undefined) return hasBody ? 'POST' : 'GET';
	const method = value.trim().toUpperCase();
	if (!(FUNCTION_REQUEST_METHODS as readonly string[]).includes(method))
		throw new UsageError(`-X must be one of ${FUNCTION_REQUEST_METHODS.join(', ')}.`);
	if (hasBody && (method === 'GET' || method === 'HEAD'))
		throw new UsageError(`${method} requests have no body. Pass -X POST (or another method) with -d.`);
	return method;
}

/** A request path: `users` and `/users` both mean `/users`; omitted means `/`. */
export function normalizeRequestPath(value: string | undefined): string {
	if (value === undefined || value === '') return '/';
	if (/^https?:\/\//i.test(value))
		throw new UsageError('Give a path such as /api/users, not a URL: the request goes straight to the function on its node.');
	return value.startsWith('/') ? value : `/${value}`;
}

/** `HTTP 200 OK` and the response headers, as `curl -i` prints them. */
export function responseHead(result: FunctionInvokeResult): string {
	const lines = [`HTTP ${result.status}${result.statusText ? ` ${result.statusText}` : ''}`];
	for (const [name, value] of result.headers) lines.push(`${name}: ${value}`);
	return lines.join('\n');
}

export function isSuccessStatus(status: number): boolean {
	return status >= 200 && status < 300;
}

/** The dim line under a test request: status, time, cold start, size. */
export function invokeSummary(result: FunctionInvokeResult): string {
	const parts = [`${result.status}${result.statusText ? ` ${result.statusText}` : ''}`, formatMs(result.durationMs)];
	if (result.coldStart) parts.push('cold start');
	parts.push(formatBytes(result.size));
	if (result.truncated) parts.push('body cut at 256 KiB');
	return parts.join(' · ');
}

/** The response body as bytes to write to stdout. */
export function responseBodyBytes(result: FunctionInvokeResult): Uint8Array {
	return result.encoding === 'base64' ? Buffer.from(result.body, 'base64') : Buffer.from(result.body, 'utf8');
}

/** `yoal function cron`: one line, failure first. */
export function scheduledSummary(cron: string, result: FunctionScheduledResult): string {
	const timing = `${formatMs(result.durationMs)}${result.coldStart ? ', cold start' : ''}`;
	if (scheduledFailed(result))
		return `scheduled() for "${cron}" failed (status ${result.status}, ${timing}): ${result.error ?? 'no error message'}`;
	return `Ran scheduled() for "${cron}": status ${result.status} in ${timing}.`;
}

export function scheduledFailed(result: FunctionScheduledResult): boolean {
	return result.status >= 400 || (result.error !== null && result.error !== '');
}
