import { fail } from '@sveltejs/kit';
import { PLATFORM_CONFIG_SECTIONS } from '@yoal/contracts';
import {
	artifactsInR2,
	backupHealth,
	clearBackupHealthCache,
	currentSection,
	localSnapshots,
	testR2
} from '#lib/server/platform-config.js';
import { formRawString, formString } from '../../_lib/errors.js';
import {
	collect,
	configState,
	fieldFailure,
	queueConfig,
	requireOwnerPage
} from '../_platform.server.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requireOwnerPage(locals);
	return {
		...configState(),
		r2: currentSection('backups'),
		artifactsInR2,
		health: await backupHealth(),
		snapshots: localSnapshots()
	};
};

function r2Fields(data: FormData) {
	return collect([
		{
			field: 'accountId',
			key: 'R2_ACCOUNT_ID',
			value: formString(data, 'accountId').toLowerCase(),
			required: true,
			label: 'Account ID'
		},
		{
			field: 'bucket',
			key: 'R2_BUCKET',
			value: formString(data, 'bucket'),
			required: true,
			label: 'Bucket'
		},
		{
			field: 'accessKeyId',
			key: 'R2_ACCESS_KEY_ID',
			value: formString(data, 'accessKeyId'),
			required: true,
			label: 'Access key ID'
		},
		{
			field: 'secretAccessKey',
			key: 'R2_SECRET_ACCESS_KEY',
			value: formRawString(data, 'secretAccessKey').trim(),
			secret: true,
			required: true,
			label: 'Secret access key'
		},
		{
			field: 'endpoint',
			key: 'R2_ENDPOINT',
			value: formString(data, 'endpoint').replace(/\/$/, ''),
			label: 'Endpoint'
		}
	]);
}

/** Effective credentials: submitted values, falling back to the running secret when left blank. */
function credentials(set: Record<string, string>) {
	return {
		accountId: set.R2_ACCOUNT_ID!,
		bucket: set.R2_BUCKET!,
		accessKeyId: set.R2_ACCESS_KEY_ID!,
		secretAccessKey: set.R2_SECRET_ACCESS_KEY ?? process.env.R2_SECRET_ACCESS_KEY ?? '',
		endpoint: set.R2_ENDPOINT
	};
}

export const actions: Actions = {
	refresh: async ({ locals }) => {
		requireOwnerPage(locals);
		clearBackupHealthCache();
		return {};
	},

	testR2: async ({ request, locals }) => {
		requireOwnerPage(locals);
		const { set, fieldErrors } = r2Fields(await request.formData());
		if (Object.keys(fieldErrors).length) return fieldFailure(fieldErrors);
		const result = await testR2(credentials(set));
		if (!result.ok) return fail(400, { message: `R2 test failed: ${result.error}` });
		return { success: `Connected to ${set.R2_BUCKET}: wrote, read and deleted a test object.` };
	},

	saveR2: async ({ request, locals }) => {
		requireOwnerPage(locals);
		const { set, unset, fieldErrors } = r2Fields(await request.formData());
		if (Object.keys(fieldErrors).length) return fieldFailure(fieldErrors);
		// Never queue credentials that do not work: Litestream would just crash-loop.
		const result = await testR2(credentials(set));
		if (!result.ok) return fail(400, { message: `Not saved — R2 test failed: ${result.error}` });
		if (artifactsInR2 && process.env.R2_BUCKET && set.R2_BUCKET !== process.env.R2_BUCKET)
			return fail(400, {
				message:
					'Release artifacts are stored in this bucket, so moving to another bucket would hide every existing release. Copy the bucket first, or change it on the server.',
				fieldErrors: { bucket: 'Artifacts live in the current bucket.' }
			});
		return queueConfig(
			locals,
			{ action: 'configure', section: 'backups', set, unset },
			'Credentials verified. Turning on backups — the dashboard restarts for a few seconds.'
		);
	},

	removeR2: async ({ locals }) => {
		requireOwnerPage(locals);
		if (artifactsInR2)
			return fail(409, {
				message: 'Release artifacts are stored in R2, so its credentials cannot be removed.'
			});
		return queueConfig(
			locals,
			{
				action: 'configure',
				section: 'backups',
				set: {},
				unset: [...PLATFORM_CONFIG_SECTIONS.backups]
			},
			'Removing the R2 credentials and turning off backups.'
		);
	},

	enable: async ({ locals }) =>
		queueConfig(locals, { action: 'backups', enabled: true }, 'Turning on backups.'),

	disable: async ({ locals }) =>
		queueConfig(locals, { action: 'backups', enabled: false }, 'Turning off backups.'),

	drill: async ({ locals }) =>
		queueConfig(locals, { action: 'restore-drill' }, 'Starting a restore drill.')
};
