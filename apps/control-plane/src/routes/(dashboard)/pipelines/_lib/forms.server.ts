import { fail } from '@sveltejs/kit';
import { ZodError } from 'zod';
import { hasPermission, type Principal } from '@yoal/contracts';
import { CoreError } from '@yoal/core';
import { failStatus, toFormFailure } from '../../_lib/errors.js';

/** What the viewer may do with pipelines; the dashboard hides actions they can't take. */
export function pipelineCan(principal: Principal) {
	return {
		manage: hasPermission(principal, 'build:create'),
		run: hasPermission(principal, 'build:create'),
		cancel: hasPermission(principal, 'build:cancel'),
		readSecrets: hasPermission(principal, 'secret:read-metadata'),
		writeSecrets:
			hasPermission(principal, 'build:create') &&
			hasPermission(principal, 'secret:create') &&
			hasPermission(principal, 'secret:delete'),
		link: hasPermission(principal, 'build:create') && hasPermission(principal, 'deployment:promote'),
		/** Environment approvals (W12): `pipeline:approve`; the server enforces it. */
		approve: hasPermission(principal, 'pipeline:approve')
	};
}

export type PipelineCan = ReturnType<typeof pipelineCan>;

/**
 * Run a `core.pipelines` call inside a form action. Core parses input with zod (a `ZodError`) and
 * checks permissions with contracts' `ForbiddenError`, neither of which is a `CoreError`.
 */
export async function attempt<T>(work: () => T | Promise<T>) {
	try {
		return { ok: true as const, value: await work() };
	} catch (error) {
		if (error instanceof ZodError) {
			const issue = error.issues[0];
			return { ok: false as const, failure: fail(400, { message: issue?.message ?? 'Check the form.' }) };
		}
		if (!(error instanceof CoreError) && error instanceof Error && error.name === 'ForbiddenError')
			return { ok: false as const, failure: fail(403, { message: error.message }) };
		return { ok: false as const, failure: fail(failStatus(error), toFormFailure(error)) };
	}
}

/** `key=value` lines → a record. Blank lines and `#` comments are skipped. */
export function parseKeyValueLines(raw: string): { values: Record<string, string>; error: string | null } {
	const values: Record<string, string> = {};
	for (const [index, line] of raw.split('\n').entries()) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const at = trimmed.indexOf('=');
		if (at <= 0) return { values, error: `Line ${index + 1}: use key=value.` };
		values[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim();
	}
	return { values, error: null };
}

/** One entry per non-blank line. */
export function lines(raw: string): string[] {
	return raw
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean);
}
