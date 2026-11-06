import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STUDIO_UNIT, ensureStudioUnit, studioUnit } from './studio.ts';

const root = mkdtempSync(join(tmpdir(), 'skiff-studio-unit-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** `Key=value` lines of one section, comments and blanks dropped. */
function directives(unit: string, section: string): Map<string, string[]> {
	const out = new Map<string, string[]>();
	let current = '';
	for (const raw of unit.split('\n')) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		const header = /^\[(.+)\]$/.exec(line);
		if (header) {
			current = header[1]!;
			continue;
		}
		if (current !== section) continue;
		const eq = line.indexOf('=');
		const key = line.slice(0, eq);
		out.set(key, [...(out.get(key) ?? []), line.slice(eq + 1)]);
	}
	return out;
}

describe('skiff-studio unit', () => {
	const unit = studioUnit();
	const service = directives(unit, 'Service');

	test('the shipped file is the rendered default', () => {
		expect(readFileSync(join(import.meta.dir, STUDIO_UNIT), 'utf8')).toBe(unit);
	});

	test('is static: no [Install] section, so it can never be enabled at boot', () => {
		expect(unit).not.toMatch(/^\[Install\]/m);
		expect(unit).not.toMatch(/^WantedBy=/m);
	});

	test('runs the agent binary studio entrypoint as skiff on the runtime socket', () => {
		expect(service.get('ExecStart')).toEqual(['/opt/skiff/current/agent/skiff-agent studio']);
		expect(service.get('User')).toEqual(['skiff']);
		expect(service.get('Group')).toEqual(['skiff']);
		expect(service.get('UMask')).toEqual(['0007']);
		expect(service.get('Environment')).toEqual(['SKIFF_STUDIO_SOCKET=/run/skiff/studio.sock']);
		// The runtime dir is `d /run/skiff 2770 root caddy`; creating the socket needs that group.
		expect(service.get('SupplementaryGroups')).toEqual(['caddy']);
	});

	test('carries no secrets: no EnvironmentFile at all', () => {
		expect(service.has('EnvironmentFile')).toBe(false);
	});

	test('a clean idle exit stays stopped; only failures restart', () => {
		expect(service.get('Restart')).toEqual(['on-failure']);
		expect(service.get('RestartSec')).toEqual(['1']);
	});

	test('has its own limits, separate from the agent cgroup', () => {
		expect(service.get('MemoryMax')).toEqual(['256M']);
		expect(service.get('TasksMax')).toEqual(['64']);
		expect(service.get('LimitNOFILE')).toEqual(['4096']);
	});

	test('mirrors the agent sandbox without netlink and with only /run/skiff writable', () => {
		const agent = directives(readFileSync(join(import.meta.dir, 'skiff-agent.service'), 'utf8'), 'Service');
		const hardening = [
			'NoNewPrivileges',
			'PrivateTmp',
			'PrivateDevices',
			'ProtectSystem',
			'ProtectHome',
			'ProtectClock',
			'ProtectHostname',
			'ProtectKernelTunables',
			'ProtectKernelModules',
			'ProtectKernelLogs',
			'ProtectControlGroups',
			'RestrictNamespaces',
			'RestrictRealtime',
			'RestrictSUIDSGID',
			'LockPersonality',
			'SystemCallArchitectures',
			'SystemCallFilter',
			'SystemCallErrorNumber',
			'CapabilityBoundingSet',
			'AmbientCapabilities',
		];
		for (const key of hardening) expect([key, service.get(key)]).toEqual([key, agent.get(key)]);
		expect(service.get('RestrictAddressFamilies')).toEqual(['AF_UNIX AF_INET AF_INET6']);
		expect(service.get('ReadWritePaths')).toEqual(['/run/skiff']);
	});

	test('honours custom paths', () => {
		const custom = studioUnit({ optDir: '/srv/opt', runDir: '/run/x', socketGroup: 'skiff-caddy' });
		expect(custom).toContain('ExecStart=/srv/opt/current/agent/skiff-agent studio');
		expect(custom).toContain('Environment=SKIFF_STUDIO_SOCKET=/run/x/studio.sock');
		expect(custom).toContain('ReadWritePaths=/run/x\n');
		expect(custom).toContain('SupplementaryGroups=skiff-caddy');
	});

	test('ensureStudioUnit writes once and reloads, and never enables or starts it', () => {
		const calls: string[] = [];
		const run = (cmd: string[]) => void calls.push(cmd.join(' '));
		expect(ensureStudioUnit({ systemdDir: root, run })).toBe(true);
		expect(readFileSync(join(root, STUDIO_UNIT), 'utf8')).toBe(unit);
		expect(statSync(join(root, STUDIO_UNIT)).mode & 0o777).toBe(0o644);
		expect(calls).toEqual(['systemctl daemon-reload']);

		expect(ensureStudioUnit({ systemdDir: root, run })).toBe(false);
		expect(calls).toEqual(['systemctl daemon-reload']);
		expect(calls.some((call) => / (enable|start|restart) /.test(` ${call} `))).toBe(false);
	});
});
