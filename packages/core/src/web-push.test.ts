import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createDecipheriv, createECDH, createHmac, createPublicKey, randomBytes, verify } from 'node:crypto';
import { migrations } from '@skiff/db';
import { generateVapidKeys, validVapidKeys, ensureVapidKeys, vapidSubject } from '@skiff/contracts/vapid';
import {
	PushNotifier,
	PushSubscriptionStore,
	encryptPushPayload,
	sendWebPush,
	vapidAuthorization,
	validPushEndpoint,
} from './web-push.ts';

/** RFC 8291 Appendix A. */
const RFC = {
	plaintext: 'When I grow up, I want to be a watermelon',
	asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
	uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
	uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
	salt: 'DGv6ra1nlYgDCS1FRnbzlw',
	auth: 'BTBZMqHH6r4Tts7J_aSIgg',
	body:
		'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

const hmac = (key: Buffer, data: Buffer) => createHmac('sha256', key).update(data).digest();

/** The browser side of RFC 8291, for round-trip tests. */
function decrypt(body: Buffer, uaPrivate: Buffer, auth: Buffer): string {
	const salt = body.subarray(0, 16);
	const idlen = body[20]!;
	const asPublic = body.subarray(21, 21 + idlen);
	const ecdh = createECDH('prime256v1');
	ecdh.setPrivateKey(uaPrivate);
	const secret = ecdh.computeSecret(asPublic);
	const prkKey = hmac(auth, secret);
	const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic, Buffer.from([1])]));
	const prk = hmac(salt, ikm);
	const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
	const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
	const ciphertext = body.subarray(21 + idlen);
	const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
	decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
	const plain = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
	expect(plain[plain.length - 1]).toBe(2);
	return plain.subarray(0, plain.length - 1).toString();
}

function browser() {
	const ecdh = createECDH('prime256v1');
	ecdh.generateKeys();
	const auth = randomBytes(16);
	return {
		privateKey: ecdh.getPrivateKey(),
		auth,
		subscription: {
			endpoint: `https://push.example.com/send/${randomBytes(6).toString('hex')}`,
			p256dh: ecdh.getPublicKey().toString('base64url'),
			auth: auth.toString('base64url'),
		},
	};
}

function db(): Database {
	const sqlite = new Database(':memory:');
	for (const migration of migrations) sqlite.exec(migration.sql);
	sqlite.exec('CREATE TABLE "user" (id TEXT PRIMARY KEY)');
	sqlite.run('INSERT INTO "user" (id) VALUES (?), (?)', ['u1', 'u2']);
	return sqlite;
}

describe('RFC 8291 encryption', () => {
	test('matches the RFC test vector', () => {
		const body = encryptPushPayload({ p256dh: RFC.uaPublic, auth: RFC.auth }, Buffer.from(RFC.plaintext), {
			salt: Buffer.from(RFC.salt, 'base64url'),
			serverPrivateKey: Buffer.from(RFC.asPrivate, 'base64url'),
		});
		expect(body.toString('base64url')).toBe(RFC.body);
	});

	test('round-trips with random keys', () => {
		const b = browser();
		const body = encryptPushPayload(b.subscription, Buffer.from('{"title":"hi"}'));
		expect(decrypt(body, b.privateKey, b.auth)).toBe('{"title":"hi"}');
	});
});

describe('VAPID', () => {
	test('generated keys are valid and ensureVapidKeys keeps a good pair', () => {
		const keys = generateVapidKeys();
		expect(validVapidKeys(keys.publicKey, keys.privateKey)).toBe(true);
		expect(validVapidKeys(keys.publicKey, generateVapidKeys().privateKey)).toBe(false);
		const env = new Map<string, string>();
		expect(ensureVapidKeys(env)).toBe(true);
		const first = env.get('SKIFF_VAPID_PUBLIC_KEY');
		expect(ensureVapidKeys(env)).toBe(false);
		expect(env.get('SKIFF_VAPID_PUBLIC_KEY')).toBe(first);
		env.set('SKIFF_VAPID_PRIVATE_KEY', 'broken');
		expect(ensureVapidKeys(env)).toBe(true);
	});

	test('the JWT verifies with the public key and names the push service', () => {
		const keys = generateVapidKeys();
		const header = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', { ...keys, subject: 'https://control.example.com' }, 1_700_000_000_000);
		const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header)!;
		expect(match[4]).toBe(keys.publicKey);
		const claims = JSON.parse(Buffer.from(match[2]!, 'base64url').toString());
		expect(claims).toEqual({ aud: 'https://fcm.googleapis.com', exp: 1_700_000_000 + 12 * 3600, sub: 'https://control.example.com' });
		const pub = Buffer.from(keys.publicKey, 'base64url');
		const key = createPublicKey({
			format: 'jwk',
			key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') },
		});
		const ok = verify('sha256', Buffer.from(`${match[1]}.${match[2]}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(match[3]!, 'base64url'));
		expect(ok).toBe(true);
	});

	test('subject prefers the configured contact, then an https origin', () => {
		expect(vapidSubject({ SKIFF_VAPID_SUBJECT: 'mailto:ops@example.com' })).toBe('mailto:ops@example.com');
		expect(vapidSubject({ SKIFF_PLATFORM_ORIGIN: 'https://control.example.com/' })).toBe('https://control.example.com');
		expect(vapidSubject({ SKIFF_PLATFORM_ORIGIN: 'http://10.0.0.1', SKIFF_CONTENT_DOMAIN: '10-0-0-1.sslip.io' })).toBe('mailto:skiff@10-0-0-1.sslip.io');
	});

	test('only https endpoints are accepted', () => {
		expect(validPushEndpoint('https://web.push.apple.com/abc')).toBe(true);
		expect(validPushEndpoint('http://169.254.169.254/latest')).toBe(false);
		expect(validPushEndpoint('https://user:pw@push.example.com/')).toBe(false);
	});
});

describe('PushNotifier', () => {
	const vapid = { ...generateVapidKeys(), subject: 'mailto:ops@example.com' };

	test('sends an encrypted alert to every device and prunes gone ones', async () => {
		const sqlite = db();
		const store = new PushSubscriptionStore(sqlite);
		const phone = browser();
		const laptop = browser();
		const gone = browser();
		store.save('u1', phone.subscription, 'iPhone');
		store.save('u2', laptop.subscription, 'Mac');
		store.save('u1', gone.subscription, 'Old phone');
		const seen: Array<{ url: string; headers: Record<string, string>; body: Buffer }> = [];
		const fakeFetch = (async (url: string, init: RequestInit) => {
			seen.push({ url, headers: init.headers as Record<string, string>, body: Buffer.from(init.body as Uint8Array) });
			return new Response(null, { status: url === gone.subscription.endpoint ? 410 : 201 });
		}) as unknown as typeof fetch;
		const notifier = new PushNotifier(store, vapid, { fetch: fakeFetch });
		await notifier.notify({ key: 'node:n1:offline', title: 'Node offline', detail: 'edge-1 stopped sending heartbeats.', severity: 'critical' });

		expect(seen).toHaveLength(3);
		const toPhone = seen.find((request) => request.url === phone.subscription.endpoint)!;
		expect(toPhone.headers['content-encoding']).toBe('aes128gcm');
		expect(toPhone.headers.urgency).toBe('high');
		expect(toPhone.headers.topic).toHaveLength(32);
		const payload = JSON.parse(decrypt(toPhone.body, phone.privateKey, phone.auth));
		expect(payload).toMatchObject({ title: 'Skiff critical: Node offline', body: 'edge-1 stopped sending heartbeats.', tag: 'node:n1:offline' });
		expect(store.all().map((d) => d.device).sort()).toEqual(['Mac', 'iPhone']);
		expect(store.byEndpoint(phone.subscription.endpoint)?.lastSuccessAt).not.toBeNull();
	});

	test('does nothing without devices, and throws only when every device failed', async () => {
		const store = new PushSubscriptionStore(db());
		const failing = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
		const notifier = new PushNotifier(store, vapid, { fetch: failing });
		const alert = { key: 't', title: 'T', detail: 'D', severity: 'info' as const };
		await notifier.notify(alert);
		const b = browser();
		store.save('u1', b.subscription, 'Pixel');
		await expect(notifier.notify(alert)).rejects.toThrow('push service returned 500');
		expect(store.byEndpoint(b.subscription.endpoint)?.lastError).toContain('500');
	});

	test('skips devices of deleted users; re-subscribing moves the endpoint', () => {
		const sqlite = db();
		const store = new PushSubscriptionStore(sqlite);
		const b = browser();
		store.save('u1', b.subscription, 'Phone');
		store.save('u2', b.subscription, 'Phone');
		expect(store.listForUser('u1')).toHaveLength(0);
		expect(store.listForUser('u2')).toHaveLength(1);
		sqlite.run('DELETE FROM "user" WHERE id = ?', ['u2']);
		expect(store.all()).toHaveLength(0);
	});

	test('rejects a non-https endpoint without calling it', async () => {
		let called = false;
		const spy = (async () => ((called = true), new Response(null, { status: 201 }))) as unknown as typeof fetch;
		const b = browser();
		await expect(sendWebPush({ ...b.subscription, endpoint: 'http://127.0.0.1/' }, { title: 't', body: 'b' }, vapid, { fetch: spy })).rejects.toThrow();
		expect(called).toBe(false);
	});
});
