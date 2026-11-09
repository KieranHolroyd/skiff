import { hasPermission, type Principal } from '@skiff/contracts';
import { core } from '#lib/server/core.js';

/** What the viewer may do with Email; the dashboard hides actions they can't take. */
export function emailCan(principal: Principal) {
	return {
		read: hasPermission(principal, 'email:read'),
		send: hasPermission(principal, 'email:send'),
		update: hasPermission(principal, 'email:update'),
		delete: hasPermission(principal, 'email:delete'),
		/** Create and revoke SMTP credentials (never on MCP, D58). */
		credentials: hasPermission(principal, 'email:credentials'),
		/** Email → Mail server: the mail node, global pause and org limits. */
		platform: core.ctx.platformIam.canAdminister(principal)
	};
}

export type EmailCan = ReturnType<typeof emailCan>;
