import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	CADDY_DNS_MODULE,
	CADDY_UNIT,
	STOCK_CADDY_UNIT,
	caddyUnit,
	ensureCaddy,
	installCaddyBinary,
	parseExecStartPath,
	restoreCaddyBinary,
	type CommandResult
} from './caddy.ts';

let root: string;

function temp(): string {
	root = mkdtempSync(join(tmpdir(), 'yoal-caddy-'));
	return root;
}

afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
});

function releaseWithCaddy(optDir: string, version = 'one'): string {
	const release = join(optDir, 'releases', version);
	mkdirSync(join(release, 'caddy'), { recursive: true });
	writeFileSync(join(release, 'caddy', 'caddy'), `caddy-${version}`);
	return release;
}

interface Call {
	cmd: string[];
	options?: { allowFailure?: boolean };
}

function fakeRun(input: {
	units: Record<string, string>;
	exec: Record<string, string>;
	failRestart?: boolean;
}): { run: (cmd: string[], options?: { allowFailure?: boolean }) => CommandResult; calls: Call[] } {
	const calls: Call[] = [];
	const run = (cmd: string[], options?: { allowFailure?: boolean }): CommandResult => {
		calls.push({ cmd, options });
		if (cmd[0] === 'systemctl' && cmd[1] === 'show') {
			const unit = cmd[cmd.length - 1]!;
			const value = cmd.includes('-p') && cmd[cmd.indexOf('-p') + 1] === 'LoadState'
				? (input.units[unit] ?? 'not-found')
				: (input.exec[unit] ?? '');
			return { code: 0, stdout: value, stderr: '' };
		}
		if (cmd[0] === 'systemctl' && cmd[1] === 'restart' && input.failRestart)
			return { code: 1, stdout: '', stderr: 'restart failed' };
		if (cmd[1] === 'version') return { code: 0, stdout: 'v2.11.8', stderr: '' };
		if (cmd[1] === 'list-modules')
			return { code: 0, stdout: `other\n${CADDY_DNS_MODULE}\n`, stderr: '' };
		return { code: 0, stdout: '', stderr: '' };
	};
	return { run, calls };
}

describe('parseExecStartPath', () => {
	test('reads the resolved path, then falls back to argv[0]', () => {
		expect(parseExecStartPath('{ path=/usr/bin/caddy ; argv[]=/usr/bin/caddy run --config x ; ignore_errors=no }')).toBe('/usr/bin/caddy');
		expect(parseExecStartPath('{ argv[]=/usr/local/bin/caddy run ; ignore_errors=no }')).toBe('/usr/local/bin/caddy');
		expect(parseExecStartPath('{ argv[]=caddy run }')).toBeNull();
		expect(parseExecStartPath('')).toBeNull();
	});
});

describe('caddyUnit', () => {
	test('prefers the release-managed unit and ignores missing ones', () => {
		const managed = fakeRun({
			units: { [CADDY_UNIT]: 'loaded', [STOCK_CADDY_UNIT]: 'loaded' },
			exec: {}
		});
		expect(caddyUnit(managed.run)).toBe(CADDY_UNIT);

		const stock = fakeRun({ units: { [STOCK_CADDY_UNIT]: 'loaded' }, exec: {} });
		expect(caddyUnit(stock.run)).toBe(STOCK_CADDY_UNIT);

		const none = fakeRun({ units: {}, exec: {} });
		expect(caddyUnit(none.run)).toBeNull();
	});
});

describe('installCaddyBinary', () => {
	test('replaces atomically, keeps a backup and skips identical bytes', () => {
		const dir = temp();
		const target = join(dir, 'bin', 'caddy');
		const first = join(dir, 'first');
		const second = join(dir, 'second');
		mkdirSync(join(dir, 'bin'));
		writeFileSync(target, 'old');
		writeFileSync(first, 'new');
		writeFileSync(second, 'new');

		expect(installCaddyBinary(first, target)).toBe(true);
		expect(readFileSync(target, 'utf8')).toBe('new');
		expect(readFileSync(`${target}.yoal-previous`, 'utf8')).toBe('old');
		expect(installCaddyBinary(second, target)).toBe(false);

		expect(restoreCaddyBinary(target)).toBe(true);
		expect(readFileSync(target, 'utf8')).toBe('old');
	});
});

describe('ensureCaddy', () => {
	test('restarts a release-managed unit once and records the binary hash', () => {
		const dir = temp();
		const optDir = join(dir, 'opt');
		const release = releaseWithCaddy(optDir);
		const exec = `${optDir}/current/caddy/caddy`;
		const { run, calls } = fakeRun({
			units: { [CADDY_UNIT]: 'loaded' },
			exec: { [CADDY_UNIT]: `{ path=${exec} ; argv[]=${exec} run ; ignore_errors=no }` }
		});

		expect(ensureCaddy({ release, optDir, run })).toBe(true);
		expect(calls.filter((call) => call.cmd[1] === 'restart')).toHaveLength(1);
		expect(existsSync(join(optDir, 'caddy.sha256'))).toBe(true);
		// Same release again: the running process is already on it.
		expect(ensureCaddy({ release, optDir, run })).toBe(false);
	});

	test('replaces the binary a stock unit executes and restores it when restart fails', () => {
		const dir = temp();
		const optDir = join(dir, 'opt');
		const release = releaseWithCaddy(optDir);
		const target = join(dir, 'usr', 'bin', 'caddy');
		mkdirSync(join(dir, 'usr', 'bin'), { recursive: true });
		writeFileSync(target, 'distro');
		const failing = fakeRun({
			units: { [STOCK_CADDY_UNIT]: 'loaded' },
			exec: { [STOCK_CADDY_UNIT]: `{ path=${target} ; argv[]=${target} run ; ignore_errors=no }` },
			failRestart: true
		});

		expect(() => ensureCaddy({ release, optDir, run: failing.run })).toThrow(/restart/);
		expect(readFileSync(target, 'utf8')).toBe('distro');
		expect(failing.calls.filter((call) => call.cmd[1] === 'restart')).toHaveLength(2);
	});

	test('restores the previous binary when rolling back to a release without Caddy', () => {
		const dir = temp();
		const optDir = join(dir, 'opt');
		const release = join(optDir, 'releases', 'old');
		mkdirSync(release, { recursive: true });
		const target = join(dir, 'usr', 'bin', 'caddy');
		mkdirSync(join(dir, 'usr', 'bin'), { recursive: true });
		writeFileSync(target, 'new');
		writeFileSync(`${target}.yoal-previous`, 'old');
		writeFileSync(join(optDir, 'caddy.sha256'), 'stale');
		const { run } = fakeRun({
			units: { [STOCK_CADDY_UNIT]: 'loaded' },
			exec: { [STOCK_CADDY_UNIT]: `{ path=${target} ; argv[]=${target} run ; ignore_errors=no }` }
		});

		expect(ensureCaddy({ release, optDir, run })).toBe(true);
		expect(readFileSync(target, 'utf8')).toBe('old');
		expect(existsSync(join(optDir, 'caddy.sha256'))).toBe(false);
	});
});
