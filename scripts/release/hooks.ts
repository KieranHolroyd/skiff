#!/usr/bin/env bun
/**
 * yoal-release: hooks a release runs on itself, invoked by the stage-0 updater with the
 * release's own Bun (`<release>/runtime/bun <release>/repo/scripts/release/hooks.ts <hook> …`).
 *
 * Protocol: the last stdout line is `YOAL_HOOK_RESULT <json>` (a {@link HookVerdict}). Stage-0
 * treats a well-formed `ok:false` verdict as the release's fault, and anything else (crash,
 * timeout, no verdict) as inconclusive, never as grounds to blocklist the release.
 *
 *   protocol                       print the protocol version and supported hooks
 *   canary --release R --scratch S --db D [--env-file F] [--master-key K] [--origin O]
 *   prepare --release R            additive yoal.env defaults, before the release first boots
 *   converge --release R [--mode update|rollback]
 *                                  units, helper, host commands, workerd, ClickHouse: make the
 *                                  host match R (scripts/release/converge.ts)
 *
 * `prepare` and `converge` always report ok:true; failed steps are listed in `warnings`.
 */
import { HOOK_PROTOCOL, runCanary, type HookVerdict } from './canary.ts';

/** Hooks this release implements, advertised by `protocol` so stage-0 only calls what exists. */
export const HOOKS = ['canary', 'prepare', 'converge'] as const;

export const RESULT_PREFIX = 'YOAL_HOOK_RESULT ';

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
		emit({ protocol: HOOK_PROTOCOL, ok: true, step: 'protocol', hooks: [...HOOKS] });
		return 0;
	}
	if (hook === 'canary') {
		const etc = process.env.YOAL_ETC_DIR ?? '/etc/yoal';
		const verdict = await runCanary({
			release: option(argv, '--release'),
			scratch: option(argv, '--scratch'),
			dbPath: option(argv, '--db'),
			envFile: option(argv, '--env-file', `${etc}/yoal.env`),
			masterKeyFile: option(argv, '--master-key', `${etc}/master.key`),
			origin: option(argv, '--origin', '') || null,
		});
		emit(verdict);
		return 0;
	}
	if (hook === 'prepare' || hook === 'converge') {
		const release = option(argv, '--release');
		const log = (message: string) => console.log(message);
		const mode = option(argv, '--mode', 'update');
		if (mode !== 'update' && mode !== 'rollback') throw new Error(`--mode must be update or rollback (got ${mode})`);
		// Loaded on demand so the canary never depends on the host-setup modules.
		const { convergeHost, prepareHost } = await import('./converge.ts');
		const report = hook === 'prepare' ? await prepareHost({ release, log }) : await convergeHost({ release, mode, log });
		for (const warning of report.warnings) console.error(`warning: ${warning}`);
		emit({ protocol: HOOK_PROTOCOL, ok: true, step: hook, changed: report.changed, warnings: report.warnings });
		return 0;
	}
	console.error(`yoal-release: unknown hook ${hook ?? '(none)'}`);
	return 64;
}

if (import.meta.main) {
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(error: unknown) => {
			console.error(`yoal-release: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
			process.exit(70);
		},
	);
}
