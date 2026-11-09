import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	IDENTITY_LITESTREAM_UNIT,
	IDENTITY_UNIT,
	ensureIdentityUnits,
	identityLitestreamUnit,
	identityUnit,
} from './identity.ts';

const root = mkdtempSync(join(tmpdir(), 'yoal-identity-unit-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

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
		out.set(line.slice(0, eq), [...(out.get(line.slice(0, eq)) ?? []), line.slice(eq + 1)]);
	}
	return out;
}

describe('yoal-identity units', () => {
	const unit = identityUnit();
	const service = directives(unit, 'Service');

	test('the shipped files are the rendered defaults', () => {
		expect(readFileSync(join(import.meta.dir, IDENTITY_UNIT), 'utf8')).toBe(unit);
		expect(readFileSync(join(import.meta.dir, IDENTITY_LITESTREAM_UNIT), 'utf8')).toBe(identityLitestreamUnit());
	});

	test('runs the agent identity entrypoint as yoal with its own cgroup and data dir', () => {
		expect(unit).not.toMatch(/^\[Install\]/m);
		expect(service.get('ExecStart')).toEqual(['/opt/yoal/current/agent/yoal-agent identity']);
		expect(service.get('User')).toEqual(['yoal']);
		expect(service.get('MemoryMax')).toEqual(['256M']);
		expect(service.get('StateDirectory')).toEqual(['yoal/identity']);
		expect(service.get('Environment')).toContain('YOAL_IDENTITY_DATA_DIR=/var/lib/yoal/identity');
	});

	test('has no extra privileges and keeps only the socket writable', () => {
		expect(service.get('CapabilityBoundingSet')).toEqual(['']);
		expect(service.get('AmbientCapabilities')).toEqual(['']);
		expect(service.get('NoNewPrivileges')).toEqual(['yes']);
		expect(service.get('ProtectSystem')).toEqual(['strict']);
		expect(service.get('ReadWritePaths')).toEqual(['/run/yoal']);
	});

	test('carries no secrets', () => {
		expect(unit).not.toMatch(/TOKEN=|PASSWORD=|SECRET=/);
	});

	test('the Litestream companion is separate and static', () => {
		const litestream = directives(identityLitestreamUnit(), 'Service');
		expect(identityLitestreamUnit()).not.toMatch(/^\[Install\]/m);
		expect(litestream.get('ExecStart')).toEqual([
			'/usr/local/bin/litestream replicate -config /etc/yoal/litestream-identity.yml',
		]);
		expect(litestream.get('ReadWritePaths')).toEqual(['/var/lib/yoal/identity']);
	});

	test('ensure writes once and reloads systemd', () => {
		const calls: string[][] = [];
		expect(ensureIdentityUnits({ systemdDir: root, run: (cmd) => calls.push(cmd) })).toBe(true);
		expect(ensureIdentityUnits({ systemdDir: root, run: (cmd) => calls.push(cmd) })).toBe(false);
		expect(calls).toEqual([['systemctl', 'daemon-reload']]);
	});
});
