import { error } from '@sveltejs/kit';
import { docs } from '#lib/server/docs.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const slug = params.slug.replace(/\/+$/, '');
	const doc = await docs.page(slug);
	if (!doc) error(404, 'There is no docs page at this address.');
	return {
		doc,
		docsNav: docs.nav(),
		// The last breadcrumb shows the page title rather than its slug.
		crumbLabel: doc.title
	};
};
