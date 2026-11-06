/**
 * The contract between the dashboard's platform settings (Settings → Backups / Notifications) and
 * the root-owned `skiff-platform-config` helper (docs/OPS.md §4.3).
 *
 * The control plane is unprivileged and `/etc/skiff` is read-only to it, so it cannot change its
 * own environment. Instead it drops `requestFile`; a systemd path unit starts
 * `skiff-platform-config.service` as root, which claims the request, validates it again with the
 * same rules as below, merges the allowlisted keys into `/etc/skiff/skiff.env`, (for backups)
 * installs Litestream + the drill timer, restarts the control plane and reports in `statusFile`.
 *
 * Unlike the self-update trigger, this request carries data the helper acts on, so both sides run
 * `parsePlatformConfigRequest`: only the keys listed in `PLATFORM_CONFIG_SECTIONS` can ever be
 * written, and every value is checked against a strict pattern (no newlines, nothing that could
 * change the meaning of the env file or of `litestream.yml`, which expands `${VAR}` before parsing).
 */

import { validCloudflareToken, validateDomainSettings, type DomainSettings } from './platform-domains.ts';

export const PLATFORM_CONFIG_DEFAULTS = {
	/** Written by the control plane (skiff-owned directory). */
	requestFile: '/var/lib/skiff/platform-config/request.json',
	/** Written by the helper (root-owned directory, group skiff can read). */
	statusFile: '/var/lib/skiff-config/status.json',
	/** Its presence means dashboard-driven configuration is wired up on this host. */
	pathUnit: '/etc/systemd/system/skiff-platform-config.path',
	/** Written by scripts/skiff-restore-drill.sh. */
	drillStatusFile: '/var/lib/skiff/drill/status.json',
	litestreamConfig: '/etc/skiff/litestream.yml',
	litestreamBin: '/usr/local/bin/litestream',
	/** Pre-upgrade / pre-restore snapshots. */
	backupsDir: '/var/lib/skiff/backups',
} as const;

/** Litestream release the helper installs when the host has none (sha256 pinned in the helper). */
export const LITESTREAM_VERSION = '0.3.13';

export type PlatformConfigSection = 'backups' | 'email' | 'sms' | 'alerts' | 'assistant';

/**
 * The only environment keys the dashboard can change, per section. The assistant is optional: it
 * stays off until `SKIFF_ASSISTANT_BASE_URL` and `SKIFF_ASSISTANT_MODEL` are set.
 */
export const PLATFORM_CONFIG_SECTIONS = {
	backups: ['R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ENDPOINT'],
	email: [
		'SKIFF_SMTP_HOST',
		'SKIFF_SMTP_PORT',
		'SKIFF_SMTP_USER',
		'SKIFF_SMTP_PASSWORD',
		'SKIFF_SMTP_FROM',
		'SKIFF_SMTP_SECURE',
	],
	/** Twilio, for SMS alerts. `FROM` is a number, a Messaging Service SID or an alphanumeric sender ID. */
	sms: ['SKIFF_TWILIO_ACCOUNT_SID', 'SKIFF_TWILIO_AUTH_TOKEN', 'SKIFF_TWILIO_FROM'],
	alerts: [
		'SKIFF_ALERT_WEBHOOK',
		'SKIFF_ALERT_EMAIL',
		'SKIFF_ALERT_SMS',
		// Chat and push channels (packages/core/src/notify-chat.ts).
		'SKIFF_ALERT_DISCORD_WEBHOOK',
		'SKIFF_ALERT_SLACK_WEBHOOK',
		'SKIFF_ALERT_TELEGRAM_BOT_TOKEN',
		'SKIFF_ALERT_TELEGRAM_CHAT_ID',
		'SKIFF_ALERT_NTFY_URL',
		'SKIFF_ALERT_NTFY_TOKEN',
	],
	assistant: [
		'SKIFF_ASSISTANT_PROVIDER',
		'SKIFF_ASSISTANT_BASE_URL',
		'SKIFF_ASSISTANT_MODEL',
		'SKIFF_ASSISTANT_API_KEY',
	],
} as const satisfies Record<PlatformConfigSection, readonly string[]>;

export type PlatformConfigKey = (typeof PLATFORM_CONFIG_SECTIONS)[PlatformConfigSection][number];

/** Never sent back to the browser; an empty form field means "keep the current value". */
export const PLATFORM_CONFIG_SECRET_KEYS: ReadonlySet<string> = new Set([
	'R2_SECRET_ACCESS_KEY',
	'SKIFF_SMTP_PASSWORD',
	'SKIFF_TWILIO_AUTH_TOKEN',
	// Anyone holding a Discord/Slack webhook URL can post to the channel: treat it as a credential.
	'SKIFF_ALERT_DISCORD_WEBHOOK',
	'SKIFF_ALERT_SLACK_WEBHOOK',
	'SKIFF_ALERT_TELEGRAM_BOT_TOKEN',
	'SKIFF_ALERT_NTFY_TOKEN',
	'SKIFF_ASSISTANT_API_KEY',
]);

/** Keys that must be present once a section is configured. */
export const PLATFORM_CONFIG_REQUIRED: Record<PlatformConfigSection, readonly PlatformConfigKey[]> = {
	backups: ['R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'],
	email: ['SKIFF_SMTP_HOST', 'SKIFF_SMTP_PORT', 'SKIFF_SMTP_FROM'],
	sms: ['SKIFF_TWILIO_ACCOUNT_SID', 'SKIFF_TWILIO_AUTH_TOKEN', 'SKIFF_TWILIO_FROM'],
	alerts: [],
	assistant: ['SKIFF_ASSISTANT_BASE_URL', 'SKIFF_ASSISTANT_MODEL'],
};

const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const EMAIL = /^[^\s@<>"]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,}$/i;
/** E.164: `+`, country code, subscriber number; 15 digits at most. */
export const E164 = /^\+[1-9]\d{6,14}$/;
/** At most this many SMS alert recipients: every alert is billed once per number. */
export const MAX_SMS_RECIPIENTS = 5;

/** `SKIFF_ALERT_SMS` is a comma-separated list of E.164 numbers. */
export function parseSmsRecipients(value: string | undefined): string[] {
	return (value ?? '')
		.split(',')
		.map((number) => number.trim())
		.filter(Boolean);
}

/** Printable, single line, no characters that systemd or the shell readers would reinterpret oddly. */
const PRINTABLE = /^[\x20-\x7e]*$/;

function validUrl(value: string, protocols: string[]): boolean {
	try {
		const url = new URL(value);
		return protocols.includes(url.protocol) && Boolean(url.hostname) && !url.username && !url.password;
	} catch {
		return false;
	}
}

/** Returns an error message, or null when the value is acceptable for the key. */
export function validatePlatformConfigValue(key: PlatformConfigKey, value: string): string | null {
	if (/[\r\n\0]/.test(value)) return 'must be a single line';
	switch (key) {
		case 'R2_ACCOUNT_ID':
			return /^[a-f0-9]{32}$/i.test(value) ? null : 'must be the 32-character Cloudflare account ID';
		case 'R2_BUCKET':
			return /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(value)
				? null
				: 'must be 3–63 lowercase letters, digits or hyphens';
		case 'R2_ACCESS_KEY_ID':
			return /^[A-Za-z0-9]{16,128}$/.test(value) ? null : 'must be 16–128 letters or digits';
		case 'R2_SECRET_ACCESS_KEY':
			return /^[A-Za-z0-9+/=_-]{16,256}$/.test(value) ? null : 'must be 16–256 characters (letters, digits, + / = _ -)';
		case 'R2_ENDPOINT':
			return /^https:\/\/[a-z0-9.-]+(?::\d{1,5})?$/i.test(value)
				? null
				: 'must be an https:// origin with no path, e.g. https://<account>.r2.cloudflarestorage.com';
		case 'SKIFF_SMTP_HOST':
			return HOSTNAME.test(value) ? null : 'must be a hostname';
		case 'SKIFF_SMTP_PORT': {
			const port = Number(value);
			return /^\d{1,5}$/.test(value) && port >= 1 && port <= 65535 ? null : 'must be a port number';
		}
		case 'SKIFF_SMTP_USER':
		case 'SKIFF_SMTP_PASSWORD':
			return PRINTABLE.test(value) && value.length <= 512 ? null : 'must be printable ASCII, at most 512 characters';
		case 'SKIFF_SMTP_FROM': {
			if (!PRINTABLE.test(value) || value.length > 256) return 'must be printable ASCII, at most 256 characters';
			const address = /<([^>]+)>\s*$/.exec(value)?.[1] ?? value;
			return EMAIL.test(address.trim()) ? null : 'must be an address, e.g. Skiff <noreply@example.com>';
		}
		case 'SKIFF_SMTP_SECURE':
			return value === '0' || value === '1' ? null : 'must be 0 or 1';
		case 'SKIFF_ALERT_WEBHOOK':
			return value.length <= 2048 && PRINTABLE.test(value) && validUrl(value, ['https:', 'http:'])
				? null
				: 'must be an http(s) URL without credentials';
		case 'SKIFF_ALERT_DISCORD_WEBHOOK':
			return /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/(?:v\d{1,2}\/)?webhooks\/\d{5,25}\/[A-Za-z0-9_-]{20,100}(?:\?thread_id=\d{5,25})?$/.test(
				value,
			)
				? null
				: 'must be a Discord webhook URL, e.g. https://discord.com/api/webhooks/<id>/<token>';
		case 'SKIFF_ALERT_SLACK_WEBHOOK':
			return value.length <= 2048 && PRINTABLE.test(value) && validUrl(value, ['https:'])
				? null
				: 'must be an https:// incoming-webhook URL without credentials';
		case 'SKIFF_ALERT_TELEGRAM_BOT_TOKEN':
			return /^\d{5,20}:[A-Za-z0-9_-]{30,64}$/.test(value) ? null : 'must be a bot token from @BotFather, e.g. 123456:ABC…';
		case 'SKIFF_ALERT_TELEGRAM_CHAT_ID':
			return /^(?:-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/.test(value)
				? null
				: 'must be a numeric chat id (groups start with -) or a @channelname';
		case 'SKIFF_ALERT_NTFY_URL': {
			if (value.length > 2048 || !PRINTABLE.test(value) || !validUrl(value, ['https:', 'http:']))
				return 'must be an http(s) URL without credentials';
			const url = new URL(value);
			const topic = url.pathname.split('/').filter(Boolean).pop() ?? '';
			return !url.search && !url.hash && /^[A-Za-z0-9_-]{1,64}$/.test(topic)
				? null
				: 'must be a topic URL, e.g. https://ntfy.sh/my-skiff-alerts';
		}
		case 'SKIFF_ALERT_NTFY_TOKEN':
			return /^[A-Za-z0-9_-]{8,128}$/.test(value) ? null : 'must be an ntfy access token, e.g. tk_…';
		case 'SKIFF_ALERT_EMAIL':
			return EMAIL.test(value) ? null : 'must be an email address';
		case 'SKIFF_ALERT_SMS': {
			const numbers = parseSmsRecipients(value);
			if (numbers.length === 0) return 'must list at least one phone number';
			if (numbers.length > MAX_SMS_RECIPIENTS) return `must list at most ${MAX_SMS_RECIPIENTS} phone numbers`;
			const bad = numbers.find((number) => !E164.test(number));
			if (bad) return `${bad} is not an international number, e.g. +447700900123`;
			return new Set(numbers).size === numbers.length ? null : 'must not list a number twice';
		}
		case 'SKIFF_TWILIO_ACCOUNT_SID':
			return /^AC[0-9a-f]{32}$/i.test(value) ? null : 'must be the Account SID: AC followed by 32 hex characters';
		case 'SKIFF_TWILIO_AUTH_TOKEN':
			return /^[A-Za-z0-9]{32}$/.test(value) ? null : 'must be the 32-character Auth Token';
		case 'SKIFF_TWILIO_FROM':
			return E164.test(value) || /^MG[0-9a-f]{32}$/i.test(value) || /^(?=.*[A-Za-z])[A-Za-z0-9 ]{1,11}$/.test(value)
				? null
				: 'must be a Twilio number (+447700900123), a Messaging Service SID (MG…) or a sender ID of up to 11 letters and digits';
		case 'SKIFF_ASSISTANT_PROVIDER':
			return ['openai', 'openai-compatible', 'openrouter', 'ollama'].includes(value)
				? null
				: 'must be openai, openai-compatible, openrouter or ollama';
		case 'SKIFF_ASSISTANT_BASE_URL': {
			if (value.length > 2048 || !PRINTABLE.test(value)) return 'must be a single-line URL';
			if (!validUrl(value, ['http:', 'https:'])) return 'must be an http(s) URL without credentials';
			return /\/$/.test(value) ? 'must not end with a slash' : null;
		}
		case 'SKIFF_ASSISTANT_MODEL':
			return /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,199}$/.test(value)
				? null
				: 'must be a model id (letters, digits, . _ : / -)';
		case 'SKIFF_ASSISTANT_API_KEY':
			return PRINTABLE.test(value) && value.length >= 8 && value.length <= 512
				? null
				: 'must be printable ASCII, 8–512 characters';
	}
}

interface RequestBase {
	/** Random id so the dashboard can match the status to its own request. */
	id: string;
	requestedAt: string;
	/** User id of the requester (the audit log is the authoritative record). */
	by: string;
}

export type PlatformConfigRequest = RequestBase &
	(
		| {
				action: 'configure';
				section: PlatformConfigSection;
				/** Keys to write. */
				set: Partial<Record<PlatformConfigKey, string>>;
				/** Keys to remove. */
				unset: PlatformConfigKey[];
		  }
		/** Turn Litestream replication and the monthly drill on (installing Litestream if needed) or off. */
		| { action: 'backups'; enabled: boolean }
		/** Start the restore drill now. */
		| { action: 'restore-drill' }
		/**
		 * Create the Web Push VAPID key pair in skiff.env if it is missing (D108), then restart the
		 * control plane. Never replaces a valid pair: that would orphan every subscribed device.
		 */
		| { action: 'push-keys' }
		/**
		 * Install (and start) or remove the optional ClickHouse telemetry store (D101). Removing
		 * keeps the stored telemetry unless `purgeData`.
		 */
		| { action: 'telemetry'; enabled: boolean; purgeData: boolean }
		/**
		 * Change the dashboard host, the content domain and HTTPS (D105). Rewrites skiff.env and the
		 * edge agent's agent.env, restarts both, and reverts if the new address does not answer.
		 * `cloudflareToken`, when given, replaces the DNS-01 token; omitted keeps the current one.
		 */
		| ({ action: 'domains'; cloudflareToken?: string } & DomainSettings)
	);

export type PlatformConfigAction = PlatformConfigRequest['action'];

const SECTIONS = Object.keys(PLATFORM_CONFIG_SECTIONS) as PlatformConfigSection[];

/** Strict parser used by the dashboard before writing and by the root helper before acting. */
export function parsePlatformConfigRequest(
	raw: unknown,
): { ok: true; request: PlatformConfigRequest } | { ok: false; error: string } {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'request must be an object' };
	const input = raw as Record<string, unknown>;
	const id = input.id;
	const requestedAt = input.requestedAt;
	const by = input.by;
	if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) return { ok: false, error: 'invalid id' };
	if (typeof requestedAt !== 'string' || Number.isNaN(Date.parse(requestedAt)))
		return { ok: false, error: 'invalid requestedAt' };
	if (typeof by !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(by)) return { ok: false, error: 'invalid by' };
	const base = { id, requestedAt, by };

	switch (input.action) {
		case 'restore-drill':
			return { ok: true, request: { ...base, action: 'restore-drill' } };
		case 'push-keys':
			return { ok: true, request: { ...base, action: 'push-keys' } };
		case 'backups':
			if (typeof input.enabled !== 'boolean') return { ok: false, error: 'enabled must be a boolean' };
			return { ok: true, request: { ...base, action: 'backups', enabled: input.enabled } };
		case 'telemetry': {
			if (typeof input.enabled !== 'boolean') return { ok: false, error: 'enabled must be a boolean' };
			const purgeData = input.purgeData ?? false;
			if (typeof purgeData !== 'boolean') return { ok: false, error: 'purgeData must be a boolean' };
			if (input.enabled && purgeData) return { ok: false, error: 'purgeData only applies when removing' };
			return { ok: true, request: { ...base, action: 'telemetry', enabled: input.enabled, purgeData } };
		}
		case 'domains': {
			const token = input.cloudflareToken;
			if (token !== undefined && (typeof token !== 'string' || !validCloudflareToken(token)))
				return { ok: false, error: 'cloudflareToken is not a valid token' };
			// Whether a token already exists on the host is the helper's to check; here only the shape.
			const settings = validateDomainSettings(input, true);
			if (!settings.ok) return { ok: false, error: `${settings.field}: ${settings.message}` };
			return {
				ok: true,
				request: { ...base, action: 'domains', ...settings.value, ...(token ? { cloudflareToken: token } : {}) },
			};
		}
		case 'configure': {
			const section = input.section as PlatformConfigSection;
			if (!SECTIONS.includes(section)) return { ok: false, error: 'unknown section' };
			const allowed: readonly string[] = PLATFORM_CONFIG_SECTIONS[section];
			const setRaw = input.set ?? {};
			const unsetRaw = input.unset ?? [];
			if (typeof setRaw !== 'object' || Array.isArray(setRaw) || setRaw === null)
				return { ok: false, error: 'set must be an object' };
			if (!Array.isArray(unsetRaw)) return { ok: false, error: 'unset must be an array' };
			const set: Partial<Record<PlatformConfigKey, string>> = {};
			for (const [key, value] of Object.entries(setRaw)) {
				if (!allowed.includes(key)) return { ok: false, error: `${key} cannot be set from the ${section} section` };
				if (typeof value !== 'string') return { ok: false, error: `${key} must be a string` };
				const problem = validatePlatformConfigValue(key as PlatformConfigKey, value);
				if (problem) return { ok: false, error: `${key} ${problem}` };
				set[key as PlatformConfigKey] = value;
			}
			const unset: PlatformConfigKey[] = [];
			for (const key of unsetRaw) {
				if (typeof key !== 'string' || !allowed.includes(key))
					return { ok: false, error: `${String(key)} cannot be unset from the ${section} section` };
				if (key in set) return { ok: false, error: `${key} is both set and unset` };
				unset.push(key as PlatformConfigKey);
			}
			return { ok: true, request: { ...base, action: 'configure', section, set, unset } };
		}
		default:
			return { ok: false, error: 'unknown action' };
	}
}

/**
 * Apply a configure request to an env map (pure; used by the helper and by tests). Returns the
 * keys that changed. Throws if a section would end up partially configured.
 */
export function applyPlatformConfig(
	env: Map<string, string>,
	request: Extract<PlatformConfigRequest, { action: 'configure' }>,
): string[] {
	const changed: string[] = [];
	for (const key of request.unset) {
		if (env.has(key)) {
			env.delete(key);
			changed.push(key);
		}
	}
	for (const [key, value] of Object.entries(request.set)) {
		if (env.get(key) !== value) {
			env.set(key, value);
			changed.push(key);
		}
	}
	const required = PLATFORM_CONFIG_REQUIRED[request.section];
	const present = required.filter((key) => env.get(key));
	if (present.length > 0 && present.length < required.length) {
		const missing = required.filter((key) => !env.get(key));
		throw new Error(`incomplete ${request.section} settings: missing ${missing.join(', ')}`);
	}
	if (request.section === 'backups' && env.get('R2_ACCOUNT_ID') && !env.get('R2_ENDPOINT')) {
		env.set('R2_ENDPOINT', `https://${env.get('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`);
		changed.push('R2_ENDPOINT');
	}
	return [...new Set(changed)];
}

export type PlatformConfigPhase = 'queued' | 'applying' | 'installing' | 'restarting' | 'done';
export type PlatformConfigOutcome = 'applied' | 'unchanged' | 'reverted' | 'rejected' | 'error';

export interface PlatformConfigStatus {
	requestId: string | null;
	action: PlatformConfigAction;
	section?: PlatformConfigSection;
	running: boolean;
	phase: PlatformConfigPhase;
	message: string;
	outcome?: PlatformConfigOutcome;
	/** Keys whose value changed (never the values). */
	changed?: string[];
	startedAt: string;
	updatedAt: string;
	finishedAt?: string;
}

/** A run that has not written progress for this long is treated as dead. */
export const PLATFORM_CONFIG_STALE_MS = 20 * 60 * 1000;

/** Written by scripts/skiff-restore-drill.sh. */
export interface RestoreDrillStatus {
	ok: boolean;
	at: string;
	reason: string;
}
