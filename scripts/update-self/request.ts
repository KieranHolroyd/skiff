import { readFileSync, rmSync } from 'node:fs';
import {
	isSelfUpdateChannel,
	isSelfUpdateMethod,
	parseMigrationApprovals,
	type MigrationApproval,
	type SelfUpdateChannel,
	type SelfUpdateMethod
} from '../../packages/contracts/src/self-update.ts';

/**
 * Read one allowlisted value from a sidecar next to the dashboard's update request, then delete it.
 *
 * The trigger unit consumes the request itself (`ExecStartPre=rm`), so form data cannot travel
 * with it. Only an allowlisted value is used; anything else is ignored. The file is removed even
 * for a CLI run or an unrecognised value, so a stale choice cannot leak into a later update.
 */
function consumeSidecar<T extends string>(
	path: string,
	trigger: string,
	allowed: (value: unknown) => value is T
): T | null {
	let value: string | null = null;
	try {
		value = readFileSync(path, 'utf8').trim();
	} catch {
		// No sidecar: a request from an older control plane, or a CLI run.
	}
	rmSync(path, { force: true });
	if (trigger !== 'dashboard' || !allowed(value)) return null;
	return value;
}

/** The dashboard's install method (`request.mode`); null falls back to `auto`. */
export function consumeRequestedMethod(path: string, trigger: string): SelfUpdateMethod | null {
	return consumeSidecar(path, trigger, isSelfUpdateMethod);
}

/** The dashboard's release channel (`request.channel`); null keeps the host's channel. */
export function consumeRequestedChannel(path: string, trigger: string): SelfUpdateChannel | null {
	return consumeSidecar(path, trigger, isSelfUpdateChannel);
}

/**
 * The dashboard's approvals of destructive migrations (`request.approve`), one `<id> <sha256>` per
 * line. Empty for a CLI run or a malformed file; the updater still checks each hash against the
 * staged release's SQL before it counts.
 */
export function consumeRequestedApprovals(path: string, trigger: string): MigrationApproval[] {
	let text = '';
	try {
		text = readFileSync(path, 'utf8');
	} catch {
		// No approvals requested.
	}
	rmSync(path, { force: true });
	if (trigger !== 'dashboard') return [];
	return parseMigrationApprovals(text) ?? [];
}
