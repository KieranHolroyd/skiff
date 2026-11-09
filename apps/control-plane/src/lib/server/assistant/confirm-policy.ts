import type * as z from 'zod';

/**
 * Which assistant tool calls stop for a human click, and how their arguments are checked. Kept
 * free of the MCP catalog so it can be tested on its own.
 *
 * These tools are not destructive in the MCP sense, but they expose or change production. They
 * still need a click in the chat, whatever their annotations say. The model reads untrusted text
 * (deployment logs, page content, database rows), so injected instructions must not be able to
 * publish a private site, mint a share link, swap the live release or rotate credentials alone.
 * The confirm endpoint re-checks this on the server before running anything.
 */
export const CONFIRM_TOOLS: ReadonlySet<string> = new Set([
	'set_access',
	'create_share_link',
	'presign_object',
	'promote_deployment',
	'rollback',
	'deploy_site',
	'deploy_files',
	'finalize_upload',
	'deploy_to_environment',
	'set_workload',
	'rotate_database_credentials',
	// A named credential's rotation restarts the apps that connect with it; a new one widens access.
	'create_database_credential',
	'rotate_database_credential',
	'restore_database',
	// Restarts the database on another image; a restore creates a database from production WAL.
	'set_database_pitr',
	'restore_database_to_time',
	'restart_database',
	// A replica reserves memory on its node, and attached apps restart once it streams (C7).
	'create_database_replica',
	// Restarts the database, and a version move is one-way.
	'update_database',
	'restart_services',
	'restart_storage',
	// Container console (D127): every replica restarts and requests fail meanwhile.
	'restart_container',
	// A new storage key widens access to buckets.
	'create_storage_key',
	'update_bucket_config',
	'create_backup_target',
	// Real mail to real people can't be recalled (docs/EMAIL.md §9).
	'send_email',
	// A sandbox recipient gets a verification email from Yoal: a third party, so a click first.
	'add_email_address',
	// Node tasks (D124) run production code: a consumer handles the message, the function the request.
	'send_queue_message',
	'redrive_queue',
	'invoke_function',
	'run_function_cron',
	// Jobs (plan 09) run production code against production data.
	'run_job',
	'run_command',
	// A log drain copies every log line out of Yoal, to a URL the model chose (DESIGN §8).
	'create_log_drain',
	// Pipelines run workflow code with the repository's secrets and may deploy (docs/PIPELINES.md §7).
	'dispatch_workflow',
	'rerun_pipeline_run',
	// IAM writes (IAM.md §9.3): a machine principal, a grant or a revocation all widen or narrow
	// access for a person, so the chat asks before the handler runs.
	'create_service_account',
	'bind_role',
	'unbind_role'
]);

export function needsConfirmation(
	name: string,
	annotations: { destructiveHint?: boolean } | undefined
): boolean {
	return annotations?.destructiveHint === true || CONFIRM_TOOLS.has(name);
}

/** Model output is untrusted: hold it to the same schema the MCP transport enforces. */
export function validateToolArgs(
	name: string,
	schema: z.ZodType | undefined,
	args: Record<string, unknown>
): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
	if (!schema) return { ok: true, args };
	const parsed = schema.safeParse(args);
	if (parsed.success) return { ok: true, args: parsed.data as Record<string, unknown> };
	return { ok: false, error: `Invalid arguments for ${name}: ${parsed.error.message}`.slice(0, 4000) };
}
