import { fail } from '@sveltejs/kit';
import { PLATFORM_CONFIG_SECTIONS } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { currentSection, testSmtp, testWebhook } from '#lib/server/platform-config.js';
import { formBoolean, formRawString, formString } from '../../_lib/errors.js';
import {
	collect,
	configState,
	fieldFailure,
	queueConfig,
	requireOwnerPage
} from '../_platform.server.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	requireOwnerPage(locals);
	return {
		...configState(),
		email: currentSection('email'),
		alerts: currentSection('alerts'),
		adminEmail: locals.user?.email ?? null,
		/** Alerts go nowhere until a channel is configured; the journal is the only record. */
		alertChannels: core.ctx.notifiers.map((notifier) => notifier.name)
	};
};

function emailFields(data: FormData) {
	return collect([
		{
			field: 'host',
			key: 'SKIFF_SMTP_HOST',
			value: formString(data, 'host'),
			required: true,
			label: 'Host'
		},
		{
			field: 'port',
			key: 'SKIFF_SMTP_PORT',
			value: formString(data, 'port') || '587',
			required: true,
			label: 'Port'
		},
		{ field: 'user', key: 'SKIFF_SMTP_USER', value: formString(data, 'user'), label: 'Username' },
		{
			field: 'password',
			key: 'SKIFF_SMTP_PASSWORD',
			value: formRawString(data, 'password'),
			secret: true,
			label: 'Password'
		},
		{
			field: 'from',
			key: 'SKIFF_SMTP_FROM',
			value: formString(data, 'from'),
			required: true,
			label: 'From address'
		},
		{
			field: 'secure',
			key: 'SKIFF_SMTP_SECURE',
			value: formBoolean(data, 'secure') ? '1' : '',
			label: 'TLS'
		}
	]);
}

function smtpOptions(set: Record<string, string>) {
	return {
		host: set.SKIFF_SMTP_HOST!,
		port: Number(set.SKIFF_SMTP_PORT),
		user: set.SKIFF_SMTP_USER ?? '',
		password: set.SKIFF_SMTP_PASSWORD ?? process.env.SKIFF_SMTP_PASSWORD ?? '',
		from: set.SKIFF_SMTP_FROM!,
		secure: set.SKIFF_SMTP_SECURE === '1' || Number(set.SKIFF_SMTP_PORT) === 465
	};
}

export const actions: Actions = {
	saveEmail: async ({ request, locals }) => {
		requireOwnerPage(locals);
		const data = await request.formData();
		const { set, unset, fieldErrors } = emailFields(data);
		if (Object.keys(fieldErrors).length) return fieldFailure(fieldErrors);
		const to = locals.user?.email;
		if (!to)
			return fail(400, { message: 'Your account has no email address to send the test to.' });
		// A broken SMTP config silently breaks sign-in links and invites, so prove it first.
		const result = await testSmtp(smtpOptions(set), to);
		if (!result.ok)
			return fail(400, { message: `Not saved — the test email to ${to} failed: ${result.error}` });
		return queueConfig(
			locals,
			{ action: 'configure', section: 'email', set, unset },
			`Test email sent to ${to}. Saving — the dashboard restarts for a few seconds.`
		);
	},

	removeEmail: async ({ locals }) =>
		queueConfig(
			locals,
			{
				action: 'configure',
				section: 'email',
				set: {},
				unset: [...PLATFORM_CONFIG_SECTIONS.email]
			},
			'Removing the SMTP settings.'
		),

	testEmail: async ({ locals }) => {
		requireOwnerPage(locals);
		const to = locals.user?.email;
		if (!process.env.SKIFF_SMTP_HOST) return fail(409, { message: 'Email is not configured yet.' });
		if (!to) return fail(400, { message: 'Your account has no email address.' });
		const result = await testSmtp(
			smtpOptions({
				SKIFF_SMTP_HOST: process.env.SKIFF_SMTP_HOST,
				SKIFF_SMTP_PORT: process.env.SKIFF_SMTP_PORT ?? '587',
				SKIFF_SMTP_USER: process.env.SKIFF_SMTP_USER ?? '',
				SKIFF_SMTP_FROM: process.env.SKIFF_SMTP_FROM ?? '',
				SKIFF_SMTP_SECURE: process.env.SKIFF_SMTP_SECURE ?? ''
			}),
			to
		);
		if (!result.ok) return fail(502, { message: `Test email failed: ${result.error}` });
		return { success: `Test email sent to ${to}.` };
	},

	saveAlerts: async ({ request, locals }) => {
		requireOwnerPage(locals);
		const data = await request.formData();
		const { set, unset, fieldErrors } = collect([
			{
				field: 'webhook',
				key: 'SKIFF_ALERT_WEBHOOK',
				value: formString(data, 'webhook'),
				label: 'Webhook URL'
			},
			{
				field: 'email',
				key: 'SKIFF_ALERT_EMAIL',
				value: formString(data, 'email'),
				label: 'Alert email'
			}
		]);
		if (Object.keys(fieldErrors).length) return fieldFailure(fieldErrors);
		if (set.SKIFF_ALERT_EMAIL && !process.env.SKIFF_SMTP_HOST)
			return fail(400, {
				message: 'Set up outbound email first; alert emails are sent through it.',
				fieldErrors: { email: 'Email is not configured.' }
			});
		if (set.SKIFF_ALERT_WEBHOOK && set.SKIFF_ALERT_WEBHOOK !== process.env.SKIFF_ALERT_WEBHOOK) {
			const result = await testWebhook(set.SKIFF_ALERT_WEBHOOK);
			if (!result.ok)
				return fail(400, {
					message: `Not saved — the test alert to the webhook failed: ${result.error}`,
					fieldErrors: { webhook: 'The webhook did not accept the test alert.' }
				});
		}
		return queueConfig(
			locals,
			{ action: 'configure', section: 'alerts', set, unset },
			'Saving alert channels — the dashboard restarts for a few seconds.'
		);
	},

	testAlert: async ({ locals }) => {
		const principal = requireOwnerPage(locals);
		if (core.ctx.notifiers.length === 0)
			return fail(409, { message: 'No alert channel is configured yet.' });
		const failures: string[] = [];
		for (const notifier of core.ctx.notifiers) {
			try {
				await notifier.notify({
					key: 'test',
					title: 'Test alert',
					detail: `This is a test alert from Skiff, sent by ${locals.user?.email ?? principal.userId}. Real alerts look like this.`,
					severity: 'info'
				});
			} catch (error) {
				failures.push(`${notifier.name}: ${(error as Error).message}`);
			}
		}
		if (failures.length)
			return fail(502, { message: `Test alert failed — ${failures.join('; ')}` });
		return {
			success: `Test alert sent via ${core.ctx.notifiers.map((n) => n.name).join(' and ')}.`
		};
	}
};
