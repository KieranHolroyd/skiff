/**
 * Absolute URL for a deployed content host.
 *
 * Production content is always HTTPS on port 443. Loopback hosts (`localhost` and any RFC 6761
 * `*.localhost` subdomain) are development-only, so they reuse the platform origin's scheme and
 * port: `bun run dev` serves them on the same Vite port over HTTP.
 */
export function contentUrl(platformOrigin: string, host: string): string {
	const normalized = host
		.trim()
		.toLowerCase()
		.replace(/\.$/, '');
	const loopback = normalized === 'localhost' || normalized.endsWith('.localhost');
	if (loopback) {
		try {
			const platform = new URL(platformOrigin);
			const port = platform.port ? `:${platform.port}` : '';
			return `${platform.protocol}//${normalized}${port}`;
		} catch {
			// Invalid platform origin (e.g. a build-time placeholder): use the dev default.
		}
	}
	return `https://${normalized}`;
}
