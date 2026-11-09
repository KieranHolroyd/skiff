import { error } from '@sveltejs/kit';
import { serverErrorStatuses, type Principal, type ServerErrorStatus } from '@yoal/contracts';
import { core } from '#lib/server/core.js';

/** Settings → Server errors is platform-wide: platform admins (platform:read) only. */
export function requireErrorViewer(locals: App.Locals): Principal {
	const principal = locals.principal;
	if (!principal || !core.ctx.platformIam.canView(principal))
		error(403, 'Only a platform admin can see server errors.');
	return principal;
}

export function canChangeErrors(principal: Principal): boolean {
	return core.ctx.platformIam.canMaintain(principal);
}

export function formStatus(value: FormDataEntryValue | null): ServerErrorStatus | null {
	return typeof value === 'string' && (serverErrorStatuses as readonly string[]).includes(value)
		? (value as ServerErrorStatus)
		: null;
}
