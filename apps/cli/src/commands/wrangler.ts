/**
 * `skif wrangler <args…>`: a passthrough to wrangler.
 *
 * It ensures wrangler is installed in the current directory (the same helper `skif deploy`
 * uses), then runs the command with inherited stdio and exits with its code. Arguments are
 * passed through untouched — this is the local dev loop (`skif wrangler dev`), tail, types and
 * everything else (docs/FUNCTIONS.md §4.11).
 */
import { printProgress } from './common.ts';
import { ensureWrangler, type WranglerInvoker } from '../wrangler.ts';

export interface WranglerCommandDeps {
	cwd?: string;
	ensure?: typeof ensureWrangler;
	log?: (message: string) => void;
	setExitCode?: (code: number) => void;
}

export async function wranglerCommand(
	argv: string[],
	deps: WranglerCommandDeps = {},
): Promise<void> {
	const cwd = deps.cwd ?? process.cwd();
	const ensure = deps.ensure ?? ensureWrangler;
	const log = deps.log ?? printProgress;
	const setExitCode =
		deps.setExitCode ??
		((code: number): void => {
			process.exitCode = code;
		});

	const invoker: WranglerInvoker = await ensure(cwd, { log });
	// With no arguments wrangler prints its own help; every other argument is passthrough.
	const code = await invoker([...argv]);
	setExitCode(code);
}
