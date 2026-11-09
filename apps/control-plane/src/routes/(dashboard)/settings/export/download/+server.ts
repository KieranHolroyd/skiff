import { error } from '@sveltejs/kit';
import { hasPermission } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import type { RequestHandler } from './$types';

/**
 * Settings → Config export → Download (docs/OPERATIONS.md §13): the same snapshot as
 * `GET /api/v1/export`, served as a file. `?format=yaml|json`, `?project=<slug>` (repeatable).
 */
export const GET: RequestHandler = async ({ locals, url }) => {
	const principal = locals.principal;
	if (!principal) error(401, 'Sign in to export the configuration.');
	if (!hasPermission(principal, 'project:read'))
		error(403, 'You need permission to read projects to export the configuration.');

	const format = url.searchParams.get('format') === 'json' ? 'json' : 'yaml';
	const projects = url.searchParams
		.getAll('project')
		.flatMap((value) => value.split(','))
		.map((value) => value.trim())
		.filter(Boolean);
	const doc = await core.configExport.export(principal, { projects });

	const label =
		(doc.org.slug ?? new URL(doc.platform.url).hostname)
			.toLowerCase()
			.replace(/[^a-z0-9.-]+/g, '-')
			.replace(/^-+|-+$/g, '') || 'org';
	const filename = `skiff-config-${label}-${doc.exportedAt.slice(0, 10)}.${format}`;
	const body =
		format === 'json'
			? `${JSON.stringify(doc, null, 2)}\n`
			: [
					'# Skiff config export: configuration only, no data and no secret values.',
					`# ${doc.platform.url}, org ${doc.org.slug ?? doc.org.id}, exported ${doc.exportedAt}`,
					Bun.YAML.stringify(JSON.parse(JSON.stringify(doc)), null, 2)
				].join('\n');

	return new Response(body, {
		headers: {
			'content-type': format === 'json' ? 'application/json; charset=utf-8' : 'application/yaml; charset=utf-8',
			'content-disposition': `attachment; filename="${filename}"`,
			'cache-control': 'no-store'
		}
	});
};
