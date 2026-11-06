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
	'restore_database',
	'restart_database',
	'restart_services',
	'restart_storage',
	'update_bucket_config',
	'create_backup_target'
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
