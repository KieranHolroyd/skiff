import { error } from '@sveltejs/kit';
import { hasPermission } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import type { PageServerLoad } from './$types';

/**
 * Settings → Config export (docs/OPERATIONS.md §13). The page only lists projects for the scope
 * picker; the export itself runs when the file is downloaded (`./download`), so opening the page
 * never writes a `config.export` audit row.
 */
export const load: PageServerLoad = ({ locals }) => {
	const principal = locals.principal!;
	if (!hasPermission(principal, 'project:read'))
		error(403, 'You need permission to read projects to export the configuration.');
	const projects = core.projects
		.list(principal)
		.map((project) => ({ slug: project.slug, name: project.name, runtime: project.runtime }))
		.sort((a, b) => a.slug.localeCompare(b.slug));
	return { projects };
};
