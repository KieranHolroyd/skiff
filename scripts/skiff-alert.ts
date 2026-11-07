#!/usr/bin/env bun
/**
 * Failure alert for Skiff's host-level jobs (DESIGN §8/§10: "failed backup or restore drill").
 *
 * Run by `skiff-alert@<unit>.service`, which `skiff-restore-drill.service` and
 * `skiff-litestream.service` name in `OnFailure=`. It sends through the same channels as the
 * control plane's Notifier (SKIFF_ALERT_WEBHOOK, SKIFF_ALERT_EMAIL via SKIFF_SMTP_*, SKIFF_ALERT_SMS via
 * SKIFF_TWILIO_*, and the Discord/Slack/Telegram/ntfy channels from SKIFF_ALERT_*), using
 * the same webhook payload, so it works even while the control plane itself is down.
 *
 * Usage: bun scripts/skiff-alert.ts <failed-unit-name>
 */
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { Database } from 'bun:sqlite';
import { validVapidKeys, vapidSubject } from '../packages/contracts/src/vapid.ts';
import { PushNotifier, PushSubscriptionStore } from '../packages/core/src/web-push.ts';
import {
	EmailNotifier,
	SmsNotifier,
	SmtpEmailTransport,
	TwilioSmsTransport,
} from '../packages/core/src/notify.ts';
import { chatNotifiersFromEnv, webhookNotifierFor } from '../packages/core/src/notify-chat.ts';

const unit = (process.argv[2] ?? '').trim();
if (!unit) {
	console.error('usage: skiff-alert.ts <failed-unit-name>');
	process.exit(64);
}

const kind = unit.startsWith('skiff-restore-drill') ? 'restore-drill' : unit.startsWith('skiff-litestream') ? 'backup' : unit;

function drillReason(): string | null {
	const dir = process.env.SKIFF_RESTORE_DRILL_DIR ?? '/var/lib/skiff/drill';
	try {
		const status = JSON.parse(readFileSync(`${dir}/status.json`, 'utf8')) as { ok?: boolean; reason?: string; at?: string };
		return status.ok === false && status.reason ? `${status.reason} (at ${status.at ?? 'unknown time'})` : null;
	} catch {
		return null;
	}
}

const reason = kind === 'restore-drill' ? drillReason() : null;
const host = hostname();
const alert = {
	key: `backup:${kind}`,
	title: `${kind} failed`,
	detail: [
		`${unit} failed on ${host}.`,
		reason ? `Reason: ${reason}` : null,
		`Inspect with: journalctl -u ${unit} -n 100`,
	]
		.filter(Boolean)
		.join('\n'),
	severity: 'critical' as const,
};

const env = process.env;
const notifiers: Array<{ name: string; notify: (a: typeof alert) => Promise<void> }> = [];
if (env.SKIFF_ALERT_WEBHOOK)
	notifiers.push(webhookNotifierFor(env.SKIFF_ALERT_WEBHOOK, { secret: env.SKIFF_ALERT_WEBHOOK_SECRET || undefined }));
notifiers.push(...chatNotifiersFromEnv(env));
if (env.SKIFF_ALERT_EMAIL && env.SKIFF_SMTP_HOST) {
	const transport = new SmtpEmailTransport({
		host: env.SKIFF_SMTP_HOST,
		port: Number(env.SKIFF_SMTP_PORT ?? 587),
		user: env.SKIFF_SMTP_USER ?? '',
		password: env.SKIFF_SMTP_PASSWORD ?? '',
		from: env.SKIFF_SMTP_FROM ?? `Skiff <noreply@${env.SKIFF_CONTENT_DOMAIN ?? 'localhost'}>`,
		secure: env.SKIFF_SMTP_SECURE === '1' ? true : undefined,
	});
	notifiers.push(new EmailNotifier(transport, env.SKIFF_ALERT_EMAIL));
}
const smsTo = (env.SKIFF_ALERT_SMS ?? '').split(',').map((n) => n.trim()).filter(Boolean);
if (smsTo.length && env.SKIFF_TWILIO_ACCOUNT_SID && env.SKIFF_TWILIO_AUTH_TOKEN && env.SKIFF_TWILIO_FROM) {
	const transport = new TwilioSmsTransport({
		accountSid: env.SKIFF_TWILIO_ACCOUNT_SID,
		authToken: env.SKIFF_TWILIO_AUTH_TOKEN,
		from: env.SKIFF_TWILIO_FROM,
	});
	notifiers.push(new SmsNotifier(transport, smsTo));
}

// Web Push to the owners' devices (D108): the subscriptions are in the control plane's database.
// This unit's filesystem is read-only, so open it read-only; pruning dead devices is then skipped.
if (validVapidKeys(env.SKIFF_VAPID_PUBLIC_KEY, env.SKIFF_VAPID_PRIVATE_KEY) && env.SKIFF_DATA_DIR) {
	const path = `${env.SKIFF_DATA_DIR}/skiff.db`;
	let sqlite: Database | null = null;
	for (const readonly of [false, true]) {
		try {
			sqlite = new Database(path, readonly ? { readonly: true } : { readwrite: true });
			sqlite.query('SELECT 1 FROM push_subscriptions LIMIT 1').all();
			break;
		} catch {
			sqlite?.close();
			sqlite = null;
		}
	}
	if (sqlite) {
		const vapid = {
			publicKey: env.SKIFF_VAPID_PUBLIC_KEY!,
			privateKey: env.SKIFF_VAPID_PRIVATE_KEY!,
			subject: vapidSubject(env),
		};
		const store = new PushSubscriptionStore(sqlite);
		if (store.count() > 0) notifiers.push(new PushNotifier(store, vapid));
	} else console.error(`[skiff-alert] push: cannot read ${path}; push alerts skipped`);
}

// Always leave a greppable line in the journal, even with no channel configured.
console.error(`[skiff-alert] ${alert.title}: ${alert.detail.replaceAll('\n', ' | ')}`);
if (!notifiers.length) {
	console.error('[skiff-alert] no alert channel (webhook, email + SMTP, SMS + Twilio) configured; alert only logged');
	process.exit(0);
}

let failed = 0;
for (const notifier of notifiers) {
	try {
		await notifier.notify(alert);
	} catch (error) {
		failed += 1;
		console.error(`[skiff-alert] ${notifier.name} failed: ${(error as Error).message}`);
	}
}
process.exit(failed === notifiers.length ? 1 : 0);
