import { promises as dns } from 'node:dns';
import { judgeReverseDns, type ReverseDnsCheck } from './setup-guide.js';

export type { ReverseDnsCheck };

const LOOKUP_TIMEOUT_MS = 3000;
/** Resolver answers that mean "no such record", as opposed to a lookup that failed. */
const NO_RECORD = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN', 'DNS_ENOTFOUND', 'DNS_ENODATA']);

/** `[]` for "no record", `null` when the lookup itself failed or timed out. */
async function lookup(run: () => Promise<string[]>): Promise<string[] | null> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<null>((resolve) => {
		timer = setTimeout(() => resolve(null), LOOKUP_TIMEOUT_MS);
	});
	try {
		return await Promise.race([
			run().catch((error: { code?: string }) => (NO_RECORD.has(error?.code ?? '') ? [] : null)),
			timeout
		]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Forward-confirmed reverse DNS for the mail node (EMAIL.md §2, preflight check 3), from the
 * control plane's resolver. The rest of preflight (port 25, blocklists) is still checked by hand.
 */
export async function checkReverseDns(ip: string, helo: string): Promise<ReverseDnsCheck> {
	const [ptr, forward] = await Promise.all([
		lookup(() => dns.reverse(ip)),
		lookup(() => dns.resolve4(helo))
	]);
	return { state: judgeReverseDns({ ip, helo, ptr, forward }), ip, helo, ptr: ptr ?? [] };
}
