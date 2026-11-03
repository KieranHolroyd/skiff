import { devPasswordLogin } from '#lib/server/config.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ url }) => {
	const raw = url.searchParams.get('redirect') ?? '/';
	// Only same-site paths are accepted; never an absolute URL (open-redirect guard).
	const redirect = raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';
	return { devPasswordLogin, redirect };
};
