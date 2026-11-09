import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAIL_UNIT, ensureMailUnit, mailUnit } from './mail.ts';

const root = mkdtempSync(join(tmpdir(), 'yoal-mail-unit-'));
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

describe('yoal-mail unit', () => {
	const unit = mailUnit();
	const service = directives(unit, 'Service');

	test('the shipped file is the rendered default', () => {
		expect(readFileSync(join(import.meta.dir, MAIL_UNIT), 'utf8')).toBe(unit);
	});

	test('is static and runs the agent binary as the agent user', () => {
		expect(unit).not.toMatch(/^\[Install\]/m);
		expect(service.get('ExecStart')).toEqual(['/opt/yoal/current/agent/yoal-agent mail']);
		expect(service.get('User')).toEqual(['yoal']);
	});

	test('its only privilege is binding low ports', () => {
		expect(service.get('AmbientCapabilities')).toEqual(['CAP_NET_BIND_SERVICE']);
		expect(service.get('CapabilityBoundingSet')).toEqual(['CAP_NET_BIND_SERVICE']);
		expect(service.get('NoNewPrivileges')).toEqual(['yes']);
		expect(service.get('ProtectSystem')).toEqual(['strict']);
		expect(service.get('StateDirectory')).toEqual(['yoal/mail']);
	});

	test('carries no secrets', () => {
		expect(unit).not.toMatch(/agent\.env|yoal\.env|TOKEN|PASSWORD/);
	});

	test('ensure writes once and reloads systemd', () => {
		const calls: string[][] = [];
		expect(ensureMailUnit({ systemdDir: root, run: (cmd) => calls.push(cmd) })).toBe(true);
		expect(ensureMailUnit({ systemdDir: root, run: (cmd) => calls.push(cmd) })).toBe(false);
		expect(calls).toEqual([['systemctl', 'daemon-reload']]);
	});
});
