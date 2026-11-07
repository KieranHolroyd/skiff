/** Helpers for a function's Test tab (D124). */
/** `Name: value` lines from the test request form; blank lines and `#` comments are skipped. */
export function parseHeaderLines(text: string): Record<string, string> {
	const headers: Record<string, string> = {};
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		const colon = line.indexOf(':');
		if (colon <= 0) throw new Error(`Header line "${line.slice(0, 60)}" needs a name, a colon and a value.`);
		const name = line.slice(0, colon).trim();
		if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) throw new Error(`"${name}" is not a valid header name.`);
		headers[name] = line.slice(colon + 1).trim();
	}
	return headers;
}

/** The request headers back as editable lines. */
export function headerLines(headers: Record<string, string>): string {
	return Object.entries(headers)
		.map(([name, value]) => `${name}: ${value}`)
		.join('\n');
}

/** Pretty-print a JSON body; anything else comes back as it was. */
export function prettyBody(body: string, contentType: string | null): string {
	const looksJson = (contentType ?? '').includes('json') || /^\s*[[{]/.test(body);
	if (!looksJson) return body;
	try {
		return JSON.stringify(JSON.parse(body), null, 2);
	} catch {
		return body;
	}
}

/** A status code's tone on the dashboard. */
export function statusTone(status: number): 'success' | 'warning' | 'danger' {
	if (status >= 500) return 'danger';
	if (status >= 400) return 'warning';
	return 'success';
}
