import { core } from '#lib/server/core.js';
import type { ContainerConsoleDeps } from '#lib/server/container-console.js';

/**
 * The container console proxy (D127) wired to the running core: dashboard, REST and MCP share it.
 * Every call reads `core` when it runs, never at import, so a swapped core (tests) is honoured.
 */
export const containerConsoleDeps: ContainerConsoleDeps = {
	console: {
		enabled: () => core.containerConsole.enabled(),
		endpoint: (principal, slug, scope, replica) =>
			core.containerConsole.endpoint(principal, slug, scope, replica),
		targets: (principal, slug) => core.containerConsole.targets(principal, slug),
		record: (principal, slug, activity) => core.containerConsole.record(principal, slug, activity),
		restart: (principal, slug) => core.containerConsole.restart(principal, slug)
	},
	gatewayPort: () => core.ctx.config.databaseGatewayPort ?? 8082
};
