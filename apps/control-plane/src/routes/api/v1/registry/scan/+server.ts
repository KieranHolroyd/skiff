import type { RequestHandler } from './$types';
import { ValidationError } from '@yoal/core';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Vulnerabilities of one image from the registry's Trivy scan (docs/REGISTRY.md G5):
 * `?repository=<org>/<name>&reference=<tag|sha256:…>` → `{ image, summary, cves }` (top 50, most severe first).
 */
export const GET: RequestHandler = (event) =>
	route(async () => {
		const repository = event.url.searchParams.get('repository');
		const reference = event.url.searchParams.get('reference') ?? 'latest';
		if (!repository) throw new ValidationError('Name the repository: ?repository=<org>/<name>.');
		return await core.registry.vulnerabilities(requirePrincipal(event), repository, reference);
	});
