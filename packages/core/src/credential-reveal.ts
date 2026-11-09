import { requirePermission, type Permission, type Principal } from '@yoal/contracts';
import { CoreError } from './errors.ts';

/**
 * Gate for revealing a resource's root connection secret (database D58, storage D67, broker D111).
 *
 * Humans read these from the dashboard session or the CLI's API key, so both `user` and `apiKey`
 * principals pass when they hold the `*:credentials` permission, which is never pre-ticked for
 * agents. MCP principals are refused here even with the permission: agents get the URL injected
 * into attached apps instead, and enforcing it in core keeps that true if a tool is ever added.
 * The caller records the audit entry for every successful read.
 */
export function requireCredentialReveal(principal: Principal, permission: Permission): void {
	requirePermission(principal, permission);
	if (principal.credential === 'oauth')
		throw new CoreError(
			'forbidden',
			'Credentials are never returned over MCP. Read them in the dashboard or with the CLI (`yoal … credentials`).',
			403,
		);
}
