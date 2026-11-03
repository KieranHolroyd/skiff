import { devPasswordLogin } from '#lib/server/config.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = () => ({ devPasswordLogin });
