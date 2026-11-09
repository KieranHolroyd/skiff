import { describe, expect, test } from 'bun:test';
import {
	PLATFORM_CONFIG_SECRET_KEYS,
	applyPlatformConfig,
	parsePlatformConfigRequest,
	parseSmsRecipients,
	validatePlatformConfigValue,
	type PlatformConfigRequest,
} from './platform-config.ts';

const base = { id: 'req_0123456789', requestedAt: '2026-11-03T12:00:00.000Z', by: 'user_1' };
const r2 = {
	R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
	R2_BUCKET: 'yoal-prod',
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
		expect(request.set.R2_BUCKET).toBe('yoal-prod');
	});

	test('rejects keys outside the section allowlist', () => {
		for (const key of ['BETTER_AUTH_SECRET', 'YOAL_PLATFORM_ORIGIN', 'YOAL_SMTP_HOST', 'PATH']) {
			const parsed = parsePlatformConfigRequest({ ...base, action: 'configure', section: 'backups', set: { [key]: 'x' } });
			expect(parsed.ok).toBe(false);
		}
		expect(parsePlatformConfigRequest({ ...base, action: 'configure', section: 'alerts', unset: ['NODE_ENV'] }).ok).toBe(false);
	});

	test('rejects values that could inject env lines or YAML structure', () => {
		const bad = [
			{ R2_BUCKET: 'yoal\nBETTER_AUTH_SECRET=x' },
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
				set: { YOAL_ALERT_EMAIL: 'a@b.co' },
				unset: ['YOAL_ALERT_EMAIL'],
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
		expect(validatePlatformConfigValue('YOAL_SMTP_FROM', 'Yoal <noreply@example.com>')).toBeNull();
		expect(validatePlatformConfigValue('YOAL_SMTP_FROM', 'noreply@example.com')).toBeNull();
		expect(validatePlatformConfigValue('YOAL_SMTP_FROM', 'Yoal')).not.toBeNull();
		expect(validatePlatformConfigValue('YOAL_SMTP_PORT', '587')).toBeNull();
		expect(validatePlatformConfigValue('YOAL_SMTP_PORT', '70000')).not.toBeNull();
		expect(validatePlatformConfigValue('YOAL_SMTP_HOST', 'email-smtp.eu-west-2.amazonaws.com')).toBeNull();
		expect(validatePlatformConfigValue('YOAL_SMTP_HOST', 'smtp host')).not.toBeNull();
		expect(validatePlatformConfigValue('YOAL_SMTP_PASSWORD', 'p@ss $word; "quoted"')).toBeNull();
		expect(validatePlatformConfigValue('YOAL_ALERT_WEBHOOK', 'https://ntfy.sh/yoal-alerts')).toBeNull();
		expect(validatePlatformConfigValue('YOAL_ALERT_WEBHOOK', 'https://user:pw@hooks.example')).not.toBeNull();
		expect(validatePlatformConfigValue('YOAL_ALERT_WEBHOOK', 'file:///etc/passwd')).not.toBeNull();
		expect(validatePlatformConfigValue('YOAL_ALERT_EMAIL', 'ops@example.com')).toBeNull();
		expect(validatePlatformConfigValue('YOAL_ALERT_WEBHOOK_SECRET', 'a3f9c0de5b7e41a2a3f9c0de5b7e41a2')).toBeNull();
		expect(validatePlatformConfigValue('YOAL_ALERT_WEBHOOK_SECRET', 'short')).not.toBeNull();
		expect(validatePlatformConfigValue('YOAL_ALERT_WEBHOOK_SECRET', 'has a space in it 123456')).not.toBeNull();
		expect(PLATFORM_CONFIG_SECRET_KEYS.has('YOAL_ALERT_WEBHOOK_SECRET')).toBe(true);
	});

	test('validates Twilio settings and SMS recipients', () => {
		const sid = `AC${'0123456789abcdef'.repeat(2)}`;
		expect(validatePlatformConfigValue('YOAL_TWILIO_ACCOUNT_SID', sid)).toBeNull();
		expect(validatePlatformConfigValue('YOAL_TWILIO_ACCOUNT_SID', `SK${'0'.repeat(32)}`)).not.toBeNull();
		expect(validatePlatformConfigValue('YOAL_TWILIO_AUTH_TOKEN', 'f'.repeat(32))).toBeNull();
		expect(validatePlatformConfigValue('YOAL_TWILIO_AUTH_TOKEN', 'short')).not.toBeNull();
		expect(validatePlatformConfigValue('YOAL_TWILIO_FROM', '+447700900123')).toBeNull();
		expect(validatePlatformConfigValue('YOAL_TWILIO_FROM', `MG${'a'.repeat(32)}`)).toBeNull();
		expect(validatePlatformConfigValue('YOAL_TWILIO_FROM', 'Yoal')).toBeNull();
		expect(validatePlatformConfigValue('YOAL_TWILIO_FROM', 'YoalAlertsX1')).not.toBeNull(); // > 11 chars
		expect(validatePlatformConfigValue('YOAL_TWILIO_FROM', '12345')).not.toBeNull(); // needs a letter
		expect(validatePlatformConfigValue('YOAL_TWILIO_FROM', '07700900123')).not.toBeNull();

		expect(validatePlatformConfigValue('YOAL_ALERT_SMS', '+447700900123')).toBeNull();
		expect(validatePlatformConfigValue('YOAL_ALERT_SMS', '+447700900123, +15005550006')).toBeNull();
		expect(validatePlatformConfigValue('YOAL_ALERT_SMS', '07700900123')).toContain('07700900123');
		expect(validatePlatformConfigValue('YOAL_ALERT_SMS', '+447700900123,+447700900123')).not.toBeNull();
		expect(validatePlatformConfigValue('YOAL_ALERT_SMS', ' , ')).not.toBeNull();
		const six = Array.from({ length: 6 }, (_, i) => `+4477009001${i}0`).join(',');
		expect(validatePlatformConfigValue('YOAL_ALERT_SMS', six)).not.toBeNull();
		expect(parseSmsRecipients(' +447700900123 ,,+15005550006 ')).toEqual(['+447700900123', '+15005550006']);
	});

	test('the sms section is all-or-nothing', () => {
		const env = new Map<string, string>();
		const parsed = parsePlatformConfigRequest({
			...base,
			action: 'configure',
			section: 'sms',
			set: { YOAL_TWILIO_FROM: 'Yoal' },
		});
		if (!parsed.ok || parsed.request.action !== 'configure') throw new Error('expected a configure request');
		const request = parsed.request;
		expect(() => applyPlatformConfig(env, request)).toThrow(/incomplete sms settings/);
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
			['YOAL_SMTP_HOST', 'smtp.example.com'],
			['YOAL_SMTP_PORT', '587'],
			['YOAL_SMTP_FROM', 'a@example.com'],
		]);
		applyPlatformConfig(
			env,
			configure({ section: 'email', unset: ['YOAL_SMTP_HOST', 'YOAL_SMTP_PORT', 'YOAL_SMTP_FROM'] }),
		);
		expect(env.size).toBe(0);
	});
});

describe('telemetry memory and restart requests', () => {
	test('memoryMb is a whole number of MiB in range, or null for the default', () => {
		const parse = (memoryMb: unknown) => parsePlatformConfigRequest({ ...base, action: 'telemetry-memory', memoryMb });
		expect(parse(1024)).toEqual({ ok: true, request: { ...base, action: 'telemetry-memory', memoryMb: 1024 } });
		expect(parse(null)).toEqual({ ok: true, request: { ...base, action: 'telemetry-memory', memoryMb: null } });
		expect(parse(undefined)).toEqual({ ok: true, request: { ...base, action: 'telemetry-memory', memoryMb: null } });
		for (const bad of [255, 65537, 1024.5, '1024', Number.NaN]) expect(parse(bad).ok).toBe(false);
	});

	test('restart takes no arguments', () => {
		expect(parsePlatformConfigRequest({ ...base, action: 'telemetry-restart' })).toEqual({
			ok: true,
			request: { ...base, action: 'telemetry-restart' },
		});
	});
});
