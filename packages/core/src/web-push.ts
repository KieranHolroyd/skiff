/**
 * Web Push alerts (D108): the platform alerts, delivered as notifications to the dashboard
 * installed as an app (or any browser an owner turned push on in).
 *
 * No SDK: the payload is encrypted with RFC 8291 (`aes128gcm`, RFC 8188) and every request is
 * signed with a VAPID JWT (RFC 8292), both with `node:crypto`, so `scripts/skiff-alert.ts` can use
 * it too while the control plane is down. Subscriptions live in `push_subscriptions` (migration
 * 0037); the push service answering 404/410 means the browser dropped it, so the row is deleted.
 */
import { createCipheriv, createECDH, createHash, createHmac, createPrivateKey, randomBytes, randomUUID, sign } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import type { Notifier } from './config.ts';

export interface PushSubscriptionKeys {
	endpoint: string;
	/** The browser's P-256 public key (65 bytes, base64url). */
	p256dh: string;
	/** The 16-byte authentication secret (base64url). */
	auth: string;
}

export interface VapidConfig {
	publicKey: string;
	privateKey: string;
	/** `mailto:` or `https:` contact for the push service operator. */
	subject: string;
}

/** What the service worker shows. Kept small: push services cap payloads at about 4 KB. */
export interface PushPayload {
	title: string;
	body: string;
	/** Collapses notifications for the same alert on the device. */
	tag?: string;
	/** Dashboard path opened on click. */
	url?: string;
	severity?: 'info' | 'warning' | 'critical';
	timestamp?: number;
}

const RECORD_SIZE = 4096;
/** Leave room for the 86-byte header, the delimiter and the 16-byte tag inside one record. */
export const MAX_PUSH_PAYLOAD = 3000;

function b64(value: string): Buffer {
	return Buffer.from(value, 'base64url');
}

function hmac(key: Buffer, ...data: Buffer[]): Buffer {
	const mac = createHmac('sha256', key);
	for (const part of data) mac.update(part);
	return mac.digest();
}

/**
 * RFC 8291 §3.4 + RFC 8188: one `aes128gcm` record. `salt` and `serverPrivateKey` are for the
 * RFC's test vector only; production always uses fresh random ones.
 */
export function encryptPushPayload(
	subscription: Pick<PushSubscriptionKeys, 'p256dh' | 'auth'>,
	plaintext: Uint8Array,
	testing: { salt?: Buffer; serverPrivateKey?: Buffer } = {},
): Buffer {
	const uaPublic = b64(subscription.p256dh);
	const authSecret = b64(subscription.auth);
	if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error('invalid p256dh key');
	if (authSecret.length < 16) throw new Error('invalid auth secret');
	const ecdh = createECDH('prime256v1');
	if (testing.serverPrivateKey) ecdh.setPrivateKey(testing.serverPrivateKey);
	else ecdh.generateKeys();
	const asPublic = ecdh.getPublicKey();
	const ecdhSecret = ecdh.computeSecret(uaPublic);
	const salt = testing.salt ?? randomBytes(16);

	// IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info" || 0x00 || ua_public || as_public, 32)
	const prkKey = hmac(authSecret, ecdhSecret);
	const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]);
	const ikm = hmac(prkKey, keyInfo);
	const prk = hmac(salt, ikm);
	const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
	const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);

	// Single (last) record: plaintext, then the 0x02 delimiter, no padding.
	const cipher = createCipheriv('aes-128-gcm', cek, nonce);
	const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);

	const header = Buffer.alloc(21);
	salt.copy(header, 0);
	header.writeUInt32BE(RECORD_SIZE, 16);
	header.writeUInt8(asPublic.length, 20);
	return Buffer.concat([header, asPublic, body]);
}

/** RFC 8292 `Authorization: vapid t=<jwt>, k=<public key>` for one push service origin. */
export function vapidAuthorization(endpoint: string, vapid: VapidConfig, now = Date.now()): string {
	const audience = new URL(endpoint).origin;
	const publicKey = b64(vapid.publicKey);
	const key = createPrivateKey({
		format: 'jwk',
		key: {
			kty: 'EC',
			crv: 'P-256',
			d: vapid.privateKey,
			x: publicKey.subarray(1, 33).toString('base64url'),
			y: publicKey.subarray(33, 65).toString('base64url'),
		},
	});
	const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
	// At most 24h is allowed; 12h leaves room for clock skew.
	const unsigned = `${encode({ typ: 'JWT', alg: 'ES256' })}.${encode({
		aud: audience,
		exp: Math.floor(now / 1000) + 12 * 3600,
		sub: vapid.subject,
	})}`;
	const signature = sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' });
	return `vapid t=${unsigned}.${signature.toString('base64url')}, k=${vapid.publicKey}`;
}

export class PushGoneError extends Error {}

/** Push endpoints must be https on a public push service; never send our JWT anywhere else. */
export function validPushEndpoint(endpoint: string): boolean {
	try {
		const url = new URL(endpoint);
		return url.protocol === 'https:' && !url.username && !url.password && endpoint.length <= 2048;
	} catch {
		return false;
	}
}

/** Validate a browser's `PushSubscription.toJSON()`. */
export function parsePushSubscription(raw: unknown): PushSubscriptionKeys | null {
	if (!raw || typeof raw !== 'object') return null;
	const { endpoint, keys } = raw as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
	if (typeof endpoint !== 'string' || !validPushEndpoint(endpoint)) return null;
	const p256dh = keys?.p256dh;
	const auth = keys?.auth;
	if (typeof p256dh !== 'string' || typeof auth !== 'string') return null;
	if (!/^[A-Za-z0-9_-]+={0,2}$/.test(p256dh) || !/^[A-Za-z0-9_-]+={0,2}$/.test(auth)) return null;
	const point = b64(p256dh);
	if (point.length !== 65 || point[0] !== 0x04 || b64(auth).length !== 16) return null;
	return { endpoint, p256dh: point.toString('base64url'), auth: b64(auth).toString('base64url') };
}

export async function sendWebPush(
	subscription: PushSubscriptionKeys,
	payload: PushPayload,
	vapid: VapidConfig,
	options: { ttlSeconds?: number; fetch?: typeof fetch } = {},
): Promise<void> {
	if (!validPushEndpoint(subscription.endpoint)) throw new PushGoneError('not an https push endpoint');
	let json = JSON.stringify(payload);
	if (Buffer.byteLength(json) > MAX_PUSH_PAYLOAD) {
		json = JSON.stringify({ ...payload, body: `${payload.body.slice(0, 1500)}…` });
	}
	const body = encryptPushPayload(subscription, Buffer.from(json));
	const headers: Record<string, string> = {
		authorization: vapidAuthorization(subscription.endpoint, vapid),
		'content-encoding': 'aes128gcm',
		'content-type': 'application/octet-stream',
		ttl: String(options.ttlSeconds ?? 24 * 3600),
		urgency: payload.severity === 'critical' ? 'high' : payload.severity === 'info' ? 'normal' : 'high',
	};
	// A newer alert with the same key replaces one still queued for an offline device.
	if (payload.tag) headers.topic = createHash('sha256').update(payload.tag).digest('base64url').slice(0, 32);
	const response = await (options.fetch ?? fetch)(subscription.endpoint, {
		method: 'POST',
		headers,
		body: new Uint8Array(body),
		signal: AbortSignal.timeout(15_000),
	});
	if (response.status === 404 || response.status === 410)
		throw new PushGoneError(`the push service no longer knows this device (${response.status})`);
	if (!response.ok) {
		const text = (await response.text().catch(() => '')).slice(0, 200).trim();
		throw new Error(`push service returned ${response.status}${text ? `: ${text}` : ''}`);
	}
}

// ------------------------------------------------------------------ subscriptions

export interface PushDevice {
	id: string;
	userId: string;
	endpoint: string;
	device: string;
	createdAt: number;
	lastSuccessAt: number | null;
	lastError: string | null;
	lastErrorAt: number | null;
}

interface Row {
	id: string;
	user_id: string;
	endpoint: string;
	p256dh: string;
	auth: string;
	device: string;
	created_at: number;
	last_success_at: number | null;
	last_error: string | null;
	last_error_at: number | null;
}

function device(row: Row): PushDevice {
	return {
		id: row.id,
		userId: row.user_id,
		endpoint: row.endpoint,
		device: row.device,
		createdAt: row.created_at,
		lastSuccessAt: row.last_success_at,
		lastError: row.last_error,
		lastErrorAt: row.last_error_at,
	};
}

/** At most this many devices per user: a runaway client cannot make every alert fan out forever. */
export const MAX_PUSH_DEVICES_PER_USER = 20;

export class PushSubscriptionStore {
	constructor(
		private readonly sqlite: Database,
		private readonly now: () => number = Date.now,
	) {}

	/** Subscribe (or re-subscribe) a browser. An endpoint moves to the user who registered it last. */
	save(userId: string, subscription: PushSubscriptionKeys, deviceLabel: string): PushDevice {
		const label = deviceLabel.slice(0, 120);
		const existing = this.sqlite
			.query<Row, [string]>('SELECT * FROM push_subscriptions WHERE endpoint = ?')
			.get(subscription.endpoint);
		if (existing) {
			this.sqlite.run(
				'UPDATE push_subscriptions SET user_id = ?, p256dh = ?, auth = ?, device = ?, last_error = NULL, last_error_at = NULL WHERE id = ?',
				[userId, subscription.p256dh, subscription.auth, label, existing.id],
			);
		} else {
			const count = this.sqlite
				.query<{ n: number }, [string]>('SELECT count(*) AS n FROM push_subscriptions WHERE user_id = ?')
				.get(userId)!.n;
			if (count >= MAX_PUSH_DEVICES_PER_USER) {
				// Drop the oldest so the new device always works.
				this.sqlite.run(
					'DELETE FROM push_subscriptions WHERE id IN (SELECT id FROM push_subscriptions WHERE user_id = ? ORDER BY created_at ASC LIMIT ?)',
					[userId, count - MAX_PUSH_DEVICES_PER_USER + 1],
				);
			}
			this.sqlite.run(
				'INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, device, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
				[`push_${randomUUID().replace(/-/g, '').slice(0, 20)}`, userId, subscription.endpoint, subscription.p256dh, subscription.auth, label, this.now()],
			);
		}
		return this.byEndpoint(subscription.endpoint)!;
	}

	byEndpoint(endpoint: string): PushDevice | null {
		const row = this.sqlite.query<Row, [string]>('SELECT * FROM push_subscriptions WHERE endpoint = ?').get(endpoint);
		return row ? device(row) : null;
	}

	listForUser(userId: string): PushDevice[] {
		return this.sqlite
			.query<Row, [string]>('SELECT * FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC')
			.all(userId)
			.map(device);
	}

	/** Every subscription whose user still exists (Better Auth's `user` table, when present). */
	all(): Array<PushDevice & PushSubscriptionKeys> {
		let rows: Row[];
		try {
			rows = this.sqlite
				.query<Row, []>('SELECT * FROM push_subscriptions WHERE user_id IN (SELECT id FROM "user")')
				.all();
		} catch {
			rows = this.sqlite.query<Row, []>('SELECT * FROM push_subscriptions').all();
		}
		return rows.map((row) => ({ ...device(row), p256dh: row.p256dh, auth: row.auth }));
	}

	count(): number {
		return this.all().length;
	}

	remove(id: string, userId?: string): boolean {
		const result = userId
			? this.sqlite.run('DELETE FROM push_subscriptions WHERE id = ? AND user_id = ?', [id, userId])
			: this.sqlite.run('DELETE FROM push_subscriptions WHERE id = ?', [id]);
		return result.changes > 0;
	}

	removeEndpoint(endpoint: string, userId: string): boolean {
		return this.sqlite.run('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', [endpoint, userId]).changes > 0;
	}

	markSuccess(id: string): void {
		this.sqlite.run('UPDATE push_subscriptions SET last_success_at = ?, last_error = NULL, last_error_at = NULL WHERE id = ?', [this.now(), id]);
	}

	markError(id: string, message: string): void {
		this.sqlite.run('UPDATE push_subscriptions SET last_error = ?, last_error_at = ? WHERE id = ?', [message.slice(0, 300), this.now(), id]);
	}
}

/** The payload for a platform alert. */
export function alertPushPayload(alert: { key: string; title: string; detail: string; severity: 'info' | 'warning' | 'critical' }, now = Date.now()): PushPayload {
	return {
		title: alert.severity === 'info' ? `Skiff: ${alert.title}` : `Skiff ${alert.severity}: ${alert.title}`,
		body: alert.detail,
		tag: alert.key,
		url: '/',
		severity: alert.severity,
		timestamp: now,
	};
}

export interface PushDeliveryResult {
	sent: number;
	removed: number;
	failures: string[];
}

/** Send to the given subscriptions; prunes the ones the push service says are gone. */
export async function deliverPush(
	store: PushSubscriptionStore,
	targets: Array<PushDevice & PushSubscriptionKeys>,
	payload: PushPayload,
	vapid: VapidConfig,
	options: { fetch?: typeof fetch } = {},
): Promise<PushDeliveryResult> {
	const result: PushDeliveryResult = { sent: 0, removed: 0, failures: [] };
	// Bookkeeping is best effort: scripts/skiff-alert.ts may only have a read-only database.
	const record = (write: () => unknown) => {
		try {
			write();
		} catch {
			/* read-only database */
		}
	};
	await Promise.all(
		targets.map(async (target) => {
			try {
				await sendWebPush(target, payload, vapid, options);
			} catch (error) {
				if (error instanceof PushGoneError) {
					record(() => store.remove(target.id));
					result.removed += 1;
					return;
				}
				const message = (error as Error).message;
				record(() => store.markError(target.id, message));
				result.failures.push(`${target.device || target.id}: ${message}`);
				return;
			}
			record(() => store.markSuccess(target.id));
			result.sent += 1;
		}),
	);
	return result;
}

/**
 * Alerts to every subscribed device. With no device subscribed it does nothing (the page says
 * so); it throws only when every device failed, so one dead phone does not fail the others.
 */
export class PushNotifier implements Notifier {
	readonly name = 'push';
	constructor(
		readonly store: PushSubscriptionStore,
		readonly vapid: VapidConfig,
		private readonly options: { fetch?: typeof fetch } = {},
	) {}

	async notify(alert: { key: string; title: string; detail: string; severity: 'info' | 'warning' | 'critical' }): Promise<void> {
		const targets = this.store.all();
		if (targets.length === 0) return;
		const result = await deliverPush(this.store, targets, alertPushPayload(alert), this.vapid, this.options);
		if (result.sent === 0 && result.failures.length) throw new Error(result.failures.join('; '));
		if (result.failures.length) console.warn(`[push] ${result.failures.length} device(s) failed: ${result.failures.join('; ')}`);
	}
}
