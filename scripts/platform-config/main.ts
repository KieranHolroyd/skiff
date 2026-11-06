#!/usr/bin/env bun
/**
 * skiff-platform-config: apply platform settings requested from the dashboard (backups, email,
 * alerts, domains), or manage backups from the command line. Runs as root. See docs/OPS.md §4.3.
 *
 * Installed as /usr/local/sbin/skiff-platform-config, which runs this file from the *current*
 * release. `skiff-platform-config install` (or any `sudo skiff-update-self` run) creates the
 * wrapper and the systemd units the dashboard needs.
 */
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
	PLATFORM_CONFIG_DEFAULTS,
	type PlatformConfigStatus,
} from '../../packages/contracts/src/platform-config.ts';
import { temporaryContentDomain, isIpv4 } from '../../packages/contracts/src/platform-domains.ts';
import { readEnvFile } from '../install/env-file.ts';
import { PlatformConfigHelper, type Host, type Layout, type RunResult } from './helper.ts';
import { ensurePlatformConfigUnits } from './units.ts';

const USAGE = `skiff-platform-config — apply Skiff platform settings (docs/OPS.md §4.3)

Usage:
  skiff-platform-config install           install the wrapper + systemd units the dashboard needs
  skiff-platform-config apply-request     apply the pending dashboard request (run by systemd)
  skiff-platform-config backups on|off    turn Litestream → R2 and the monthly restore drill on or off
  skiff-platform-config drill             start the restore drill now
  skiff-platform-config push-keys         add the Web Push (VAPID) keys if missing and restart the control plane
  skiff-platform-config telemetry on|off [--purge]  install or remove the ClickHouse telemetry store
  skiff-platform-config domains --platform-host <host|ip> [--content-domain <domain>]
                        [--acme-email <email> [--cloudflare-token-file <path>]]
                                          change the dashboard/site domains (HTTPS with --acme-email).
                                          Without --content-domain an IP host gets <ip>.sslip.io.
                                          The way back if a domain change left the dashboard unreachable.
  skiff-platform-config status            print the last result as JSON
`;

const ETC_DIR = process.env.SKIFF_ETC_DIR ?? '/etc/skiff';
const OPT_DIR = process.env.SKIFF_OPT_DIR ?? '/opt/skiff';
const RUN_DIR = process.env.SKIFF_RUN_DIR ?? '/run/skiff';
const STATUS_FILE = process.env.SKIFF_CONFIG_STATUS_FILE ?? PLATFORM_CONFIG_DEFAULTS.statusFile;

const layout: Layout = {
	envFile: join(ETC_DIR, 'skiff.env'),
	systemdDir: process.env.SKIFF_SYSTEMD_DIR ?? '/etc/systemd/system',
	sbinDir: '/usr/local/sbin',
	optDir: OPT_DIR,
	sourceDir: resolve(import.meta.dir, '../..'),
	bunBin: process.execPath,
	litestreamBin: PLATFORM_CONFIG_DEFAULTS.litestreamBin,
	litestreamConfig: join(ETC_DIR, 'litestream.yml'),
	drillDir: process.env.SKIFF_RESTORE_DRILL_DIR ?? '/var/lib/skiff/drill',
	requestFile: process.env.SKIFF_CONFIG_REQUEST_FILE ?? PLATFORM_CONFIG_DEFAULTS.requestFile,
	agentEnvFile: join(ETC_DIR, 'agent.env'),
	cloudflareTokenFile: join(ETC_DIR, 'cloudflare.token'),
};

function run(cmd: string[], options: { allowFailure?: boolean } = {}): RunResult {
	const proc = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe' });
	const result = { code: proc.exitCode ?? 1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
	if (result.code !== 0 && !options.allowFailure)
		throw new Error(`${cmd.join(' ')} failed (${result.code}): ${result.stderr.trim().split('\n').slice(-3).join(' ')}`);
	return result;
}

let skiffGid: number | null | undefined;
function skiffGroupId(): number | null {
	if (skiffGid === undefined) {
		const gid = Number(run(['getent', 'group', 'skiff'], { allowFailure: true }).stdout.split(':')[2]);
		skiffGid = Number.isInteger(gid) ? gid : null;
	}
	return skiffGid;
}

function chownRootSkiff(path: string): void {
	const gid = skiffGroupId();
	if (gid !== null) chownSync(path, 0, gid);
	chmodSync(path, 0o640);
}

/** root:skiff 0750 directory, 0640 file: the control plane can read it, never write it. */
function writeStatus(status: PlatformConfigStatus): void {
	try {
		const dir = dirname(STATUS_FILE);
		mkdirSync(dir, { recursive: true, mode: 0o750 });
		const gid = skiffGroupId();
		if (gid !== null) chownSync(dir, 0, gid);
		chmodSync(dir, 0o750);
		const tmp = `${STATUS_FILE}.tmp-${process.pid}`;
		writeFileSync(tmp, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o640 });
		if (gid !== null) chownSync(tmp, 0, gid);
		renameSync(tmp, STATUS_FILE);
	} catch (error) {
		console.error(`(could not write ${STATUS_FILE}: ${(error as Error).message})`);
	}
}

async function controlPlaneHealthy(): Promise<boolean> {
	const origin = readEnvFile(layout.envFile).get('SKIFF_PLATFORM_ORIGIN') ?? 'http://localhost';
	let host = 'localhost';
	try {
		host = new URL(origin).host;
	} catch {
		/* keep localhost */
	}
	try {
		const proto = origin.startsWith('https:') ? 'https' : 'http';
		const response = await fetch('http://localhost/api/setup/status', {
			unix: join(RUN_DIR, 'control.sock'),
			headers: { Host: host, 'X-Forwarded-Proto': proto, 'X-Forwarded-Host': host },
			signal: AbortSignal.timeout(3_000),
		});
		if (response.status !== 200) return false;
		const body = (await response.json()) as { needsSetup?: unknown };
		return typeof body.needsSetup === 'boolean';
	} catch {
		return false;
	}
}

/**
 * Through Caddy on this host: `--resolve` pins the name to loopback, so this proves Caddy routes
 * the new host to the control plane (and, with HTTPS, holds a valid certificate for it) without
 * waiting on public DNS caches.
 */
async function platformAnswers(origin: string): Promise<boolean> {
	let url: URL;
	try {
		url = new URL('/api/setup/status', origin);
	} catch {
		return false;
	}
	const port = url.port || (url.protocol === 'https:' ? '443' : '80');
	const result = run(
		['curl', '-fsS', '--max-time', '10', '--resolve', `${url.hostname}:${port}:127.0.0.1`, url.toString()],
		{ allowFailure: true },
	);
	if (result.code !== 0) return false;
	try {
		return typeof (JSON.parse(result.stdout) as { needsSetup?: unknown }).needsSetup === 'boolean';
	} catch {
		return false;
	}
}

async function download(url: string): Promise<Uint8Array> {
	const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
	if (!response.ok) throw new Error(`downloading ${url} failed: HTTP ${response.status}`);
	return new Uint8Array(await response.arrayBuffer());
}

const host: Host = {
	run,
	log: (message) => console.log(`skiff-platform-config: ${message}`),
	sleep: (ms) => Bun.sleep(ms),
	download,
	controlPlaneHealthy,
	platformAnswers,
	writeStatus,
	chownRootSkiff,
};

function newRequestId(): string {
	return `cli_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

async function main(): Promise<number> {
	const [command, arg] = process.argv.slice(2);
	if (!command || command === 'help' || command === '--help' || command === '-h') {
		console.log(USAGE);
		return command ? 0 : 64;
	}
	if (command === 'status') {
		console.log(existsSync(STATUS_FILE) ? readFileSync(STATUS_FILE, 'utf8').trim() : 'null');
		return 0;
	}
	if (process.getuid?.() !== 0) {
		console.error('skiff-platform-config: must run as root');
		return 1;
	}
	if (command === 'install') {
		ensurePlatformConfigUnits({
			systemdDir: layout.systemdDir,
			requestFile: layout.requestFile,
			optDir: OPT_DIR,
			bunBin: layout.bunBin,
			run: (cmd) => void run(cmd, { allowFailure: true }),
			log: host.log,
		});
		host.log('ready: Settings → Backups, Notifications and Domains can now change this host');
		return 0;
	}

	const helper = new PlatformConfigHelper(layout, host);
	let status: PlatformConfigStatus | null;
	const base = { id: newRequestId(), requestedAt: new Date().toISOString(), by: 'cli' };
	if (command === 'apply-request') status = await helper.applyRequestFile();
	else if (command === 'backups' && (arg === 'on' || arg === 'off'))
		status = await helper.apply({ ...base, action: 'backups', enabled: arg === 'on' });
	else if (command === 'drill') status = await helper.apply({ ...base, action: 'restore-drill' });
	else if (command === 'push-keys') status = await helper.apply({ ...base, action: 'push-keys' });
	else if (command === 'telemetry' && (arg === 'on' || arg === 'off'))
		status = await helper.apply({
			...base,
			action: 'telemetry',
			enabled: arg === 'on',
			purgeData: arg === 'off' && process.argv.includes('--purge'),
		});
	else if (command === 'domains') {
		const flag = (name: string) => {
			const index = process.argv.indexOf(name);
			return index > 0 ? (process.argv[index + 1] ?? '') : '';
		};
		const platformHost = flag('--platform-host').trim().toLowerCase();
		const acmeEmail = flag('--acme-email').trim();
		const tokenFile = flag('--cloudflare-token-file');
		let contentDomain = flag('--content-domain').trim().toLowerCase();
		if (!contentDomain && isIpv4(platformHost)) contentDomain = temporaryContentDomain(platformHost);
		const cloudflareToken = tokenFile ? readFileSync(tokenFile, 'utf8').trim() : undefined;
		status = await helper.apply({
			...base,
			action: 'domains',
			platformHost,
			contentDomain,
			tls: Boolean(acmeEmail),
			acmeEmail,
			...(cloudflareToken ? { cloudflareToken } : {}),
		});
	} else {
		console.error(`skiff-platform-config: unknown command ${command}\n\n${USAGE}`);
		return 64;
	}
	if (!status) {
		host.log('no pending request');
		return 0;
	}
	host.log(status.message);
	return status.outcome === 'applied' || status.outcome === 'unchanged' ? 0 : 1;
}

process.exit(await main());
