import { fail, type Action } from '@sveltejs/kit';
import {
	emailAccessRequestCreateSchema,
	emailSandboxAddressCreateSchema,
	type Principal
} from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { failStatus, formOptionalString, formString, toFormFailure } from '../../_lib/errors.js';
import { fieldErrorsFrom } from '../../databases/_lib/forms.server.js';

/**
 * The sandbox (docs/EMAIL.md §4.3, §7.3): sandbox recipients and the request to leave it. The
 * Sandbox page uses every action; the overview's setup checklist spreads in `request`, so the
 * request form behaves the same wherever it opens.
 */

/** Only an org owner or admin may ask to leave the sandbox. */
export function canRequestAccess(principal: Principal): boolean {
	return core.email.canRequestProductionAccess(principal);
}

const add: Action = async ({ request, locals }) => {
	const values = { address: formString(await request.formData(), 'address') };
	const parsed = emailSandboxAddressCreateSchema.safeParse(values);
	if (!parsed.success)
		return fail(400, {
			message: 'Check the highlighted fields.',
			fieldErrors: fieldErrorsFrom(parsed.error.issues),
			values
		});
	try {
		const added = await core.email.addSandboxAddress(locals.principal!, parsed.data);
		return {
			success:
				added.status === 'verified'
					? `${added.address} is already verified.`
					: `Verification link sent to ${added.address}. It works once and expires in 24 hours.`
		};
	} catch (caught) {
		return fail(failStatus(caught), { ...toFormFailure(caught), values });
	}
};

const resend: Action = async ({ request, locals }) => {
	const address = formString(await request.formData(), 'address');
	if (!address) return fail(400, { message: 'An address is required.' });
	try {
		await core.email.addSandboxAddress(locals.principal!, { address });
	} catch (caught) {
		return fail(failStatus(caught), toFormFailure(caught));
	}
	return { success: `A new link went to ${address}; earlier links no longer work.` };
};

const remove: Action = async ({ request, locals }) => {
	const address = formString(await request.formData(), 'address');
	if (!address) return fail(400, { message: 'An address is required.' });
	try {
		core.email.removeSandboxAddress(locals.principal!, address);
	} catch (caught) {
		return fail(failStatus(caught), toFormFailure(caught));
	}
	return { success: `${address} is no longer a sandbox recipient.` };
};

const requestAccess: Action = async ({ request, locals }) => {
	const data = await request.formData();
	const volume = formString(data, 'expectedDailyVolume');
	const values = {
		useCase: formString(data, 'useCase'),
		expectedDailyVolume: volume === '' ? Number.NaN : Number(volume),
		website: formOptionalString(data, 'website')
	};
	const parsed = emailAccessRequestCreateSchema.safeParse(values);
	if (!parsed.success)
		return fail(400, {
			message: 'Check the highlighted fields.',
			fieldErrors: fieldErrorsFrom(parsed.error.issues),
			values: { ...values, expectedDailyVolume: volume }
		});
	try {
		await core.email.requestProductionAccess(locals.principal!, parsed.data);
	} catch (caught) {
		return fail(failStatus(caught), {
			...toFormFailure(caught),
			values: { ...values, expectedDailyVolume: volume }
		});
	}
	return {
		success: 'Request sent. A platform admin reviews it; you get an email with the answer.'
	};
};

export const sandboxActions = { add, resend, remove, request: requestAccess };
