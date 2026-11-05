#!/usr/bin/env bun
/**
 * skiff-release: hooks a release runs on itself, invoked by the stage-0 updater with the
 * release's own Bun (`<release>/runtime/bun <release>/repo/scripts/release/hooks.ts <hook> …`).
 *
 * Protocol: the last stdout line is `SKIFF_HOOK_RESULT <json>` (a {@link HookVerdict}). Stage-0
 * treats a well-formed `ok:false` verdict as the release's fault, and anything else (crash,
 * timeout, no verdict) as inconclusive, never as grounds to blocklist the release.
 *
 *   protocol                       print the protocol version and supported hooks
 *   canary --release R --scratch S --db D [--env-file F] [--master-key K] [--origin O]
 */
import { HOOK_PROTOCOL, runCanary, type HookVerdict } from './canary.ts';

export const RESULT_PREFIX = 'SKIFF_HOOK_RESULT ';

function emit(verdict: HookVerdict | Record<string, unknown>): void {
	console.log(`${RESULT_PREFIX}${JSON.stringify(verdict)}`);
}

function option(argv: string[], name: string, fallback?: string): string {
	const index = argv.indexOf(name);
	const value = index >= 0 ? argv[index + 1] : undefined;
	if (value && !value.startsWith('--')) return value;
	if (fallback !== undefined) return fallback;
	throw new Error(`${name} is required`);
}

async function main(argv: string[]): Promise<number> {
	const hook = argv.shift();
	if (hook === 'protocol') {
		emit({ protocol: HOOK_PROTOCOL, ok: true, step: 'protocol', hooks: ['canary'] });
		return 0;
	}
	if (hook === 'canary') {
		const etc = process.env.SKIFF_ETC_DIR ?? '/etc/skiff';
		const verdict = await runCanary({
			release: option(argv, '--release'),
			scratch: option(argv, '--scratch'),
			dbPath: option(argv, '--db'),
			envFile: option(argv, '--env-file', `${etc}/skiff.env`),
			masterKeyFile: option(argv, '--master-key', `${etc}/master.key`),
			origin: option(argv, '--origin', '') || null,
		});
		emit(verdict);
		return 0;
	}
	console.error(`skiff-release: unknown hook ${hook ?? '(none)'}`);
	return 64;
}

if (import.meta.main) {
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(error: unknown) => {
			console.error(`skiff-release: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
			process.exit(70);
		},
	);
}
