/**
 * Open-redirect guard for `?redirect=` parameters. Resolves `raw` against the platform origin the
 * way a browser would (so `/\evil.com`, `/\t/evil.com` and `https:evil.com` are caught) and only
 * accepts it when the result stays on that origin. Returns a root-relative path that can never be
 * read as protocol-relative (`//host`).
 */
export function safeRedirect(raw: string | null | undefined, origin: string, fallback = '/'): string {
	if (!raw) return fallback;
	let url: URL;
	try {
		url = new URL(raw, origin);
	} catch {
		return fallback;
	}
	if (url.origin !== new URL(origin).origin) return fallback;
	const path = url.pathname.replace(/^\/{2,}/, '/');
	return `${path}${url.search}${url.hash}`;
}
