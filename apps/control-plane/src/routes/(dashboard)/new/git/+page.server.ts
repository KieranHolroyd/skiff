import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/** Deploy from Git lives at `/new/github` (it lists every provider); this is its provider-neutral address. */
export const load: PageServerLoad = ({ url }) => {
	redirect(307, `/new/github${url.search}`);
};
