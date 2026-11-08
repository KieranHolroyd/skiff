import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/** Settings → Email moved into the Email area as Mail server (docs/EMAIL.md §3.3). */
export const load: PageServerLoad = () => redirect(308, '/email/server');
