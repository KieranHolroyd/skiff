import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/** Network shares moved to Settings → Network shares; keep old links and bookmarks working. */
export const load: PageServerLoad = ({ url }) => {
	redirect(308, `/settings/shares${url.search}`);
};
