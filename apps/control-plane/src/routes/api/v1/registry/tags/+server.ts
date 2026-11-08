import type { RequestHandler } from './$types';
import { ValidationError } from '@skiff/core';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

function repository(url: URL): string {
	const name = url.searchParams.get('repository');
	if (!name) throw new ValidationError('Name the repository: ?repository=<org>/<name>.');
	return name;
}

/** Tags of one repository (`?repository=<org>/<name>`); deployment pins are hidden. */
export const GET: RequestHandler = (event) =>
	route(async () => ({ tags: await core.registry.tags(requirePrincipal(event), repository(event.url)) }));

/** Delete one tag (`?repository=…&tag=…`); needs `image:delete`. */
export const DELETE: RequestHandler = (event) =>
	route(async () => {
		const tag = event.url.searchParams.get('tag');
		if (!tag) throw new ValidationError('Name the tag: &tag=<tag>.');
		await core.registry.deleteTag(requirePrincipal(event), repository(event.url), tag);
		return { deleted: true };
	});
