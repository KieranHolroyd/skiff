import type { RequestHandler } from './$types';
import { emailAccessRequestStatuses, type EmailAccessRequestStatus } from '@yoal/contracts';
import { ValidationError } from '@yoal/core';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Production access requests from every org, pending first (EMAIL.md §7.3). Platform admins only. `?status&limit`. */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const params = event.url.searchParams;
		const status = params.get('status');
		if (status && !(emailAccessRequestStatuses as readonly string[]).includes(status))
			throw new ValidationError(`status must be one of ${emailAccessRequestStatuses.join(', ')}.`);
		const limit = Number(params.get('limit') ?? 100);
		return {
			requests: core.email.listAccessRequests(principal, {
				...(status ? { status: status as EmailAccessRequestStatus } : {}),
				...(Number.isFinite(limit) ? { limit } : {})
			})
		};
	});
