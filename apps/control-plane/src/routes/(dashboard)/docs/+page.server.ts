import { redirect } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import { docs } from '#lib/server/docs.js';
import type { PageServerLoad } from './$types';

/** A bare `/docs` opens the introduction. */
export const load: PageServerLoad = () => {
	redirect(307, resolve('/(dashboard)/docs/[...slug]', { slug: docs.home }));
};
