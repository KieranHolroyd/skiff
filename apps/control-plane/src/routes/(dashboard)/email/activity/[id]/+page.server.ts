import { error } from '@sveltejs/kit';
import { CoreError } from '@skiff/core';
import type { EmailMessageView } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, params }) => {
	const principal = locals.principal!;
	let message: EmailMessageView;
	try {
		message = core.email.getMessage(principal, params.id);
	} catch (caught) {
		if (caught instanceof CoreError) error(caught.status, caught.message);
		throw caught;
	}
	let project: string | null = null;
	if (message.projectId) {
		try {
			project =
				core.projects.list(principal).find((entry) => entry.id === message.projectId)?.slug ?? null;
		} catch {
			// The project link is a nicety.
		}
	}
	return { message, project, crumbLabel: null };
};
