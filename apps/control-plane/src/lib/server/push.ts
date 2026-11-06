import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { building } from '$app/env';
import { PushNotifier, PushSubscriptionStore, type VapidConfig } from '@skiff/core';
import {
	VAPID_PRIVATE_KEY_ENV,
	VAPID_PUBLIC_KEY_ENV,
	generateVapidKeys,
	validVapidKeys,
	vapidSubject
} from '@skiff/contracts/vapid';
import { dataDir } from './config';
import { sqlite } from './db';

/**
 * Web Push alerts (D108). The VAPID key pair comes from `/etc/skiff/skiff.env`, written by the
 * installer and by `skiff-update-self` (or by Settings → Notifications → Set up push, through the
 * root helper, on a host updated by an older updater). A dev server makes its own pair in
 * `<SKIFF_DATA_DIR>/vapid.json` so push works without an install.
 */
function loadVapid(): VapidConfig | null {
	if (building) return null;
	const env = process.env;
	const subject = vapidSubject(env);
	const publicKey = env[VAPID_PUBLIC_KEY_ENV];
	const privateKey = env[VAPID_PRIVATE_KEY_ENV];
	if (validVapidKeys(publicKey, privateKey))
		return { publicKey: publicKey!, privateKey: privateKey!, subject };
	if (publicKey || privateKey)
		console.warn(
			`[push] ${VAPID_PUBLIC_KEY_ENV}/${VAPID_PRIVATE_KEY_ENV} are not a valid P-256 pair; push alerts are off`
		);
	if (env.NODE_ENV === 'production') return null;
	const file = join(dataDir, 'vapid.json');
	try {
		if (existsSync(file)) {
			const saved = JSON.parse(readFileSync(file, 'utf8')) as {
				publicKey?: string;
				privateKey?: string;
			};
			if (validVapidKeys(saved.publicKey, saved.privateKey))
				return { publicKey: saved.publicKey!, privateKey: saved.privateKey!, subject };
		}
		const keys = generateVapidKeys();
		mkdirSync(dataDir, { recursive: true });
		writeFileSync(file, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 });
		return { ...keys, subject };
	} catch (error) {
		console.warn('[push] could not create dev VAPID keys:', (error as Error).message);
		return null;
	}
}

export const vapid = loadVapid();
export const pushStore = new PushSubscriptionStore(sqlite);
/** Null until the host has VAPID keys. */
export const pushNotifier = vapid ? new PushNotifier(pushStore, vapid) : null;
