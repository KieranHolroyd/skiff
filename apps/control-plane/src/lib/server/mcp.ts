import {
	McpServer,
	acceptedContent,
	createMcpHandler,
	inputRequired,
	type AuthInfo,
	type ScopeChallengeHandler,
} from '@modelcontextprotocol/server';
import { effectivePermissions, type Permission } from '@skiff/contracts';
import * as z from 'zod';

/**
 * Skiff's MCP server (DESIGN §6.3).
 *
 * SPIKE STATUS: proves auth, scope enforcement, scope step-up and destructive-action
 * confirmation end to end. Tool bodies are stubs until the service layer (packages/core)
 * exists; every real tool must call the service layer, never the DB directly.
 */

type Principal = { userId: string; clientId: string; permissions: Set<Permission> };

function principalFrom(authInfo: AuthInfo | undefined): Principal | undefined {
	if (!authInfo) return undefined;
	const userId = String(authInfo.extra?.sub ?? '');
	// TODO(orgs): resolve the user's role in the active org. Until orgs exist the
	// single platform user is treated as owner; tokens are still capped by their scopes.
	return {
		userId,
		clientId: authInfo.clientId,
		permissions: effectivePermissions(authInfo.scopes, 'owner'),
	};
}

/**
 * Ask the client to step up its grant when the token lacks a permission the tool needs.
 * The challenge lists the *complete* scope set (existing + required) per RFC 6750.
 */
const requires =
	(...needed: Permission[]): ScopeChallengeHandler =>
	({ authInfo }) => {
		const granted = new Set(authInfo?.scopes ?? []);
		const missing = needed.filter((p) => !granted.has(p));
		if (missing.length === 0) return undefined;
		const scopes = [...new Set([...granted, ...missing])] as [string, ...string[]];
		return {
			scopes,
			errorDescription: `This tool needs ${missing.join(', ')}. Re-authorize to grant it.`,
		};
	};

const text = (value: unknown) => ({
	content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});

function buildServer(principal: Principal | undefined, era: 'legacy' | 'modern') {
	const server = new McpServer({ name: 'skiff', version: '0.0.1' });

	server.registerTool(
		'whoami',
		{
			title: 'Who am I',
			description: 'Show the authenticated user, MCP client and the effective Skiff permissions of this token.',
			annotations: { readOnlyHint: true, idempotentHint: true },
		},
		async () =>
			text({
				userId: principal?.userId,
				clientId: principal?.clientId,
				permissions: [...(principal?.permissions ?? [])].sort(),
			}),
	);

	server.registerTool(
		'list_projects',
		{
			title: 'List projects',
			description: 'List projects you can access, with their production URLs.',
			annotations: { readOnlyHint: true, idempotentHint: true },
			scopeChallenge: requires('project:read'),
		},
		async () => text({ projects: [], note: 'spike stub' }),
	);

	const confirmSchema = z.object({ confirm: z.boolean() });
	server.registerTool(
		'delete_project',
		{
			title: 'Delete project',
			description:
				'Soft-delete a project (stops serving immediately; restorable for 7 days). Requires the user to confirm.',
			inputSchema: z.object({ project: z.string().describe('Project slug') }),
			annotations: { destructiveHint: true, idempotentHint: true },
			scopeChallenge: requires('project:delete'),
		},
		async ({ project }, ctx) => {
			// 2025-era clients are served statelessly and can't receive input requests, so the
			// human-in-the-loop step can't happen over MCP: hand the action to the dashboard.
			if (era === 'legacy')
				return {
					isError: true,
					...text(
						`Deleting "${project}" needs your confirmation, which this MCP client can't show. ` +
							`Ask the user to delete it from the Skiff dashboard (Projects → ${project} → Delete).`,
					),
				};
			// Human-in-the-loop confirmation via multi-round-trip input (MCP 2026-07-28).
			// The confirmation key embeds the slug so a "yes" for one project can't be replayed for another.
			const key = `confirm_delete:${project}`;
			const answer = acceptedContent(ctx.mcpReq.inputResponses, key, confirmSchema);
			const responded = ctx.mcpReq.inputResponses?.[key] !== undefined;
			// The user answered but didn't accept with confirm=true (declined, cancelled, or unticked):
			// stop here instead of asking again.
			if (responded && answer?.confirm !== true)
				return text(`Cancelled: "${project}" was not deleted (the user did not confirm).`);
			if (answer?.confirm !== true) {
				return inputRequired({
					inputRequests: {
						[key]: inputRequired.elicit({
							message: `Delete project "${project}"? It stops serving immediately and can be restored for 7 days.`,
							requestedSchema: confirmSchema,
						}),
					},
				});
			}
			return text(`Project "${project}" moved to trash (spike stub).`);
		},
	);

	return server;
}

export const mcpHandler = createMcpHandler(({ authInfo, era }) => buildServer(principalFrom(authInfo), era), {
	// Serve 2025-era clients statelessly too; destructive tools on that path return an error
	// asking the user to act in the dashboard (no multi-round-trip input there).
	legacy: 'stateless',
	onerror: (error) => console.error('[mcp]', error),
});
