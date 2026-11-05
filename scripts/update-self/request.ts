import { readFileSync, rmSync } from 'node:fs';
import {
	isSelfUpdateMethod,
	type SelfUpdateMethod
} from '../../packages/contracts/src/self-update.ts';

/**
 * Read the dashboard's install method from the sidecar next to the update request, then delete it.
 *
 * The trigger unit consumes the request itself (`ExecStartPre=rm`), so form data cannot travel
 * with it. Only the allowlisted method is used; everything else falls back to `auto`. The file is
 * removed even for a CLI run or an unrecognised value, so a stale choice cannot leak into a later
 * update.
 */
export function consumeRequestedMethod(path: string, trigger: string): SelfUpdateMethod | null {
	let value: string | null = null;
	try {
		value = readFileSync(path, 'utf8').trim();
	} catch {
		// No sidecar: a request from an older control plane, or a CLI run.
	}
	rmSync(path, { force: true });
	if (trigger !== 'dashboard' || !isSelfUpdateMethod(value)) return null;
	return value;
}
