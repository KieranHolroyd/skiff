import { describe, expect, test } from 'bun:test';
import { wranglerCommand } from './wrangler.ts';
import type { WranglerInvoker } from '../wrangler.ts';

function invoker(calls: string[][], code = 0): WranglerInvoker {
	const invoke = (async (args: string[]) => {
		calls.push(args);
		return code;
	}) as WranglerInvoker;
	return Object.assign(invoke, {
		command: 'wrangler',
		display: 'wrangler',
		ephemeral: false,
		installed: true,
	});
}

describe('yoal wrangler', () => {
	test('ensures wrangler in the current directory and passes arguments through exactly', async () => {
		const calls: string[][] = [];
		const seen: string[] = [];
		let exitCode: number | undefined;
		const args = ['dev', '--port', '8787', '--config', 'wrangler.jsonc', '--', '--extra'];

		await wranglerCommand(args, {
			cwd: '/projects/demo',
			ensure: async (cwd) => {
				seen.push(cwd);
				return invoker(calls, 3);
			},
			log: () => {},
			setExitCode: (code) => {
				exitCode = code;
			},
		});

		expect(seen).toEqual(['/projects/demo']);
		expect(calls).toEqual([args]);
		expect(exitCode).toBe(3);
	});

	test('with no arguments runs wrangler with no arguments (its own help)', async () => {
		const calls: string[][] = [];
		let exitCode: number | undefined;
		await wranglerCommand([], {
			cwd: '/projects/demo',
			ensure: async () => invoker(calls),
			log: () => {},
			setExitCode: (code) => {
				exitCode = code;
			},
		});
		expect(calls).toEqual([[]]);
		expect(exitCode).toBe(0);
	});

	test('does not rewrite --help', async () => {
		const calls: string[][] = [];
		await wranglerCommand(['--help'], {
			ensure: async () => invoker(calls),
			log: () => {},
			setExitCode: () => {},
		});
		expect(calls).toEqual([['--help']]);
	});
});
