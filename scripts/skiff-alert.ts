#!/usr/bin/env bun
/**
 * Failure alert for Skiff's host-level jobs (DESIGN §8/§10: "failed backup or restore drill").
 *
 * Run by `skiff-alert@<unit>.service`, which `skiff-restore-drill.service` and
 * `skiff-litestream.service` name in `OnFailure=`. It sends through the same channels as the
 * control plane's Notifier (SKIFF_ALERT_WEBHOOK and/or SKIFF_ALERT_EMAIL via SKIFF_SMTP_*), using
 * the same webhook payload, so it works even while the control plane itself is down.
 *
 * Usage: bun scripts/skiff-alert.ts <failed-unit-name>
 */
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { EmailNotifier, SmtpEmailTransport, WebhookNotifier } from '../packages/core/src/notify.ts';

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
if (env.SKIFF_ALERT_WEBHOOK) notifiers.push(new WebhookNotifier(env.SKIFF_ALERT_WEBHOOK));
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

// Always leave a greppable line in the journal, even with no channel configured.
console.error(`[skiff-alert] ${alert.title}: ${alert.detail.replaceAll('\n', ' | ')}`);
if (!notifiers.length) {
	console.error('[skiff-alert] no SKIFF_ALERT_WEBHOOK or SKIFF_ALERT_EMAIL + SKIFF_SMTP_HOST configured; alert only logged');
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
