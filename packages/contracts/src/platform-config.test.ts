import { describe, expect, test } from 'bun:test';
import {
	applyPlatformConfig,
	parsePlatformConfigRequest,
	validatePlatformConfigValue,
	type PlatformConfigRequest,
} from './platform-config.ts';

const base = { id: 'req_0123456789', requestedAt: '2026-11-03T12:00:00.000Z', by: 'user_1' };
const r2 = {
	R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
	R2_BUCKET: 'skiff-prod',
	R2_ACCESS_KEY_ID: 'abcdef0123456789abcdef0123456789',
	R2_SECRET_ACCESS_KEY: 'f'.repeat(64),
};

function configure(raw: Record<string, unknown>) {
	const parsed = parsePlatformConfigRequest({ ...base, action: 'configure', ...raw });
	if (!parsed.ok) throw new Error(parsed.error);
	return parsed.request as Extract<PlatformConfigRequest, { action: 'configure' }>;
}

describe('parsePlatformConfigRequest', () => {
	test('accepts a backups configure request', () => {
		const request = configure({ section: 'backups', set: r2, unset: [] });
		expect(request.set.R2_BUCKET).toBe('skiff-prod');
	});

	test('rejects keys outside the section allowlist', () => {
		for (const key of ['BETTER_AUTH_SECRET', 'SKIFF_PLATFORM_ORIGIN', 'SKIFF_SMTP_HOST', 'PATH']) {
			const parsed = parsePlatformConfigRequest({ ...base, action: 'configure', section: 'backups', set: { [key]: 'x' } });
			expect(parsed.ok).toBe(false);
		}
		expect(parsePlatformConfigRequest({ ...base, action: 'configure', section: 'alerts', unset: ['NODE_ENV'] }).ok).toBe(false);
	});

	test('rejects values that could inject env lines or YAML structure', () => {
		const bad = [
			{ R2_BUCKET: 'skiff\nBETTER_AUTH_SECRET=x' },
			{ R2_BUCKET: 'a: {b}' },
			{ R2_SECRET_ACCESS_KEY: 'abc def ghi jkl mno' },
			{ R2_ENDPOINT: 'https://evil.example/path' },
			{ R2_ACCOUNT_ID: 'not-hex' },
		];
		for (const set of bad)
			expect(parsePlatformConfigRequest({ ...base, action: 'configure', section: 'backups', set }).ok).toBe(false);
	});

	test('rejects unknown actions, bad ids and malformed shapes', () => {
		expect(parsePlatformConfigRequest(null).ok).toBe(false);
		expect(parsePlatformConfigRequest({ ...base, action: 'shell' }).ok).toBe(false);
		expect(parsePlatformConfigRequest({ ...base, id: '../x', action: 'restore-drill' }).ok).toBe(false);
		expect(parsePlatformConfigRequest({ ...base, action: 'backups', enabled: 'yes' }).ok).toBe(false);
		expect(parsePlatformConfigRequest({ ...base, action: 'configure', section: 'shell', set: {} }).ok).toBe(false);
		expect(
			parsePlatformConfigRequest({
				...base,
				action: 'configure',
				section: 'alerts',
				set: { SKIFF_ALERT_EMAIL: 'a@b.co' },
				unset: ['SKIFF_ALERT_EMAIL'],
			}).ok,
		).toBe(false);
	});

	test('accepts the simple actions', () => {
		expect(parsePlatformConfigRequest({ ...base, action: 'restore-drill' }).ok).toBe(true);
		expect(parsePlatformConfigRequest({ ...base, action: 'backups', enabled: false }).ok).toBe(true);
	});
});

describe('validatePlatformConfigValue', () => {
	test('email and webhook values', () => {
		expect(validatePlatformConfigValue('SKIFF_SMTP_FROM', 'Skiff <noreply@example.com>')).toBeNull();
		expect(validatePlatformConfigValue('SKIFF_SMTP_FROM', 'noreply@example.com')).toBeNull();
		expect(validatePlatformConfigValue('SKIFF_SMTP_FROM', 'Skiff')).not.toBeNull();
		expect(validatePlatformConfigValue('SKIFF_SMTP_PORT', '587')).toBeNull();
		expect(validatePlatformConfigValue('SKIFF_SMTP_PORT', '70000')).not.toBeNull();
		expect(validatePlatformConfigValue('SKIFF_SMTP_HOST', 'email-smtp.eu-west-2.amazonaws.com')).toBeNull();
		expect(validatePlatformConfigValue('SKIFF_SMTP_HOST', 'smtp host')).not.toBeNull();
		expect(validatePlatformConfigValue('SKIFF_SMTP_PASSWORD', 'p@ss $word; "quoted"')).toBeNull();
		expect(validatePlatformConfigValue('SKIFF_ALERT_WEBHOOK', 'https://ntfy.sh/skiff-alerts')).toBeNull();
		expect(validatePlatformConfigValue('SKIFF_ALERT_WEBHOOK', 'https://user:pw@hooks.example')).not.toBeNull();
		expect(validatePlatformConfigValue('SKIFF_ALERT_WEBHOOK', 'file:///etc/passwd')).not.toBeNull();
		expect(validatePlatformConfigValue('SKIFF_ALERT_EMAIL', 'ops@example.com')).toBeNull();
	});
});

describe('applyPlatformConfig', () => {
	test('merges keys, derives the R2 endpoint and reports what changed', () => {
		const env = new Map([['NODE_ENV', 'production']]);
		const changed = applyPlatformConfig(env, configure({ section: 'backups', set: r2 }));
		expect(env.get('R2_ENDPOINT')).toBe(`https://${r2.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`);
		expect(env.get('NODE_ENV')).toBe('production');
		expect(changed).toContain('R2_SECRET_ACCESS_KEY');
		expect(applyPlatformConfig(env, configure({ section: 'backups', set: r2 }))).toEqual([]);
	});

	test('keeps an omitted secret and refuses a half-configured section', () => {
		const env = new Map(Object.entries(r2));
		const { R2_SECRET_ACCESS_KEY: _omitted, ...rest } = r2;
		applyPlatformConfig(env, configure({ section: 'backups', set: { ...rest, R2_BUCKET: 'other-bucket' } }));
		expect(env.get('R2_SECRET_ACCESS_KEY')).toBe(r2.R2_SECRET_ACCESS_KEY);
		expect(() => applyPlatformConfig(env, configure({ section: 'backups', unset: ['R2_BUCKET'] }))).toThrow(/incomplete/);
	});

	test('removing every key of a section is allowed', () => {
		const env = new Map([
			['SKIFF_SMTP_HOST', 'smtp.example.com'],
			['SKIFF_SMTP_PORT', '587'],
			['SKIFF_SMTP_FROM', 'a@example.com'],
		]);
		applyPlatformConfig(
			env,
			configure({ section: 'email', unset: ['SKIFF_SMTP_HOST', 'SKIFF_SMTP_PORT', 'SKIFF_SMTP_FROM'] }),
		);
		expect(env.size).toBe(0);
	});
});
