import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STORAGE_LINK } from './builder.ts';
import { ensureStorageUnits, STORAGE_PATH_UNIT, STORAGE_SERVICE_UNIT, storageUnits } from './storage.ts';

const dir = mkdtempSync(join(tmpdir(), 'skiff-storage-units-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('skiff-storage units', () => {
	test('the service consumes the request, runs the apply as root, and both units are gated', () => {
		const units = storageUnits();
		const service = units[STORAGE_SERVICE_UNIT]!;
		expect(service).toContain('ExecStartPre=/bin/rm -f /run/skiff/storage.request');
		expect(service).toContain(`ExecStart=/opt/skiff/current/agent/${STORAGE_LINK} storage apply`);
		expect(service).not.toContain('User=');
		for (const body of Object.values(units)) {
			expect(body).toContain('ConditionPathExists=/etc/skiff/agent.env');
			expect(body).toContain(`ConditionPathExists=/opt/skiff/current/agent/${STORAGE_LINK}`);
		}
		expect(units[STORAGE_PATH_UNIT]).toContain('PathExists=/run/skiff/storage.request');
	});

	test('ensureStorageUnits writes once and always enables the path unit', () => {
		const calls: string[] = [];
		const run = (cmd: string[]) => void calls.push(cmd.join(' '));
		expect(ensureStorageUnits({ systemdDir: dir, run })).toBe(true);
		expect(readFileSync(join(dir, STORAGE_SERVICE_UNIT), 'utf8')).toBe(storageUnits()[STORAGE_SERVICE_UNIT]!);
		expect(calls).toEqual(['systemctl daemon-reload', `systemctl enable --now ${STORAGE_PATH_UNIT}`]);
		calls.length = 0;
		expect(ensureStorageUnits({ systemdDir: dir, run })).toBe(false);
		expect(calls).toEqual([`systemctl enable --now ${STORAGE_PATH_UNIT}`]);
	});
});
