import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePlatformConfigRequest, type PlatformConfigRequest } from '@yoal/contracts';
import { loadLocalSettings, localSettingsPath, saveLocalSettings } from './local-settings';

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'yoal-local-settings-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function configure(body: Record<string, unknown>) {
	const parsed = parsePlatformConfigRequest({
		id: 'local_0123456789',
		requestedAt: new Date().toISOString(),
		by: 'user_1',
		action: 'configure',
		...body
	});
	if (!parsed.ok) throw new Error(parsed.error);
	return parsed.request as Extract<PlatformConfigRequest, { action: 'configure' }>;
}

const smtp = {
	YOAL_SMTP_HOST: 'smtp.example.com',
	YOAL_SMTP_PORT: '587',
	YOAL_SMTP_FROM: 'Yoal <noreply@example.com>',
	YOAL_SMTP_PASSWORD: 'p@ss $word'
};

describe('local settings (dev server)', () => {
	test('save writes an owner-only file, updates the env, and a fresh process loads it', () => {
		const env: Record<string, string | undefined> = { YOAL_DATA_DIR: dir };
		const changed = saveLocalSettings(configure({ section: 'email', set: smtp }), env);
		expect(changed).toContain('YOAL_SMTP_HOST');
		expect(env.YOAL_SMTP_PASSWORD).toBe('p@ss $word');
		expect(statSync(localSettingsPath(env)).mode & 0o777).toBe(0o600);

		const restarted: Record<string, string | undefined> = { YOAL_DATA_DIR: dir };
		loadLocalSettings(restarted);
		expect(restarted.YOAL_SMTP_FROM).toBe('Yoal <noreply@example.com>');
	});

	test('removing a section overrides the shell environment after a restart', () => {
		const env: Record<string, string | undefined> = {
			YOAL_DATA_DIR: dir,
			YOAL_ALERT_WEBHOOK: 'https://ntfy.sh/a'
		};
		saveLocalSettings(configure({ section: 'alerts', unset: ['YOAL_ALERT_WEBHOOK'] }), env);
		expect(env.YOAL_ALERT_WEBHOOK).toBeUndefined();
		const restarted: Record<string, string | undefined> = {
			YOAL_DATA_DIR: dir,
			YOAL_ALERT_WEBHOOK: 'https://ntfy.sh/a'
		};
		loadLocalSettings(restarted);
		expect(restarted.YOAL_ALERT_WEBHOOK).toBeUndefined();
	});

	test('only allowlisted keys are ever loaded from the file', () => {
		writeFileSync(
			localSettingsPath({ YOAL_DATA_DIR: dir }),
			JSON.stringify({ BETTER_AUTH_SECRET: 'pwned', YOAL_ALERT_EMAIL: 'ops@example.com' })
		);
		const env: Record<string, string | undefined> = {
			YOAL_DATA_DIR: dir,
			BETTER_AUTH_SECRET: 'real'
		};
		loadLocalSettings(env);
		expect(env.BETTER_AUTH_SECRET).toBe('real');
		expect(env.YOAL_ALERT_EMAIL).toBe('ops@example.com');
	});

	test('a section is never left half-configured', () => {
		const env: Record<string, string | undefined> = { YOAL_DATA_DIR: dir };
		saveLocalSettings(configure({ section: 'email', set: smtp }), env);
		expect(() =>
			saveLocalSettings(configure({ section: 'email', unset: ['YOAL_SMTP_HOST'] }), env)
		).toThrow(/incomplete/);
		expect(JSON.parse(readFileSync(localSettingsPath(env), 'utf8')).YOAL_SMTP_HOST).toBe(
			'smtp.example.com'
		);
	});
});
