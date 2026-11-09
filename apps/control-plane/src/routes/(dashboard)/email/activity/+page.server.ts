import { redirect } from '@sveltejs/kit';
import type { EmailMessageView } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { messageIdQuery, readActivityFilters } from '../_lib/email-ui.js';
import type { PageServerLoad } from './$types';

const PAGE_SIZE = 50;

/** The message log (docs/EMAIL.md §8.1): newest first, paged with `before`. */
export const load: PageServerLoad = ({ locals, url }) => {
	const filters = readActivityFilters(url.searchParams);
	// A message id in the search box opens that message.
	const id = messageIdQuery(filters.q);
	if (id) redirect(303, `/email/activity/${id}`);

	let messages: EmailMessageView[] = [];
	let denied = false;
	try {
		// One extra row tells whether an older page exists.
		messages = core.email.listMessages(locals.principal!, {
			limit: PAGE_SIZE + 1,
			recipient: filters.q || undefined,
			status: filters.status || undefined,
			before: filters.before || undefined
		});
	} catch {
		denied = true;
	}
	const more = messages.length > PAGE_SIZE;
	const page = messages.slice(0, PAGE_SIZE);
	return {
		denied,
		filters,
		messages: page,
		/** `before` for the next (older) page, or null on the last one. */
		older: more ? page.at(-1)!.createdAt : null
	};
};
