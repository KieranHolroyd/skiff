import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/** The setup guide became the overview's checklist (docs/EMAIL.md §9); old links land there. */
export const load: PageServerLoad = () => redirect(308, '/email#email-setup');
