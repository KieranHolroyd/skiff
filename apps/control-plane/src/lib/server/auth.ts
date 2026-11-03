import { betterAuth } from 'better-auth';
import { jwt } from 'better-auth/plugins';
import { sveltekitCookies } from 'better-auth/svelte-kit';
import { mcp } from '@better-auth/mcp';
import { cimd } from '@better-auth/cimd';
import { fetchClientMetadataResource } from '@better-auth/cimd/node';
import { allPermissions } from '@skiff/contracts';
import { getRequestEvent } from '$app/server';
import { allowDcr, authSecret, devPasswordLogin, mcpResource, platformOrigin } from './config';
import { db } from './db';

export const auth = betterAuth({
	baseURL: platformOrigin,
	secret: authSecret,
	database: db,
	emailAndPassword: { enabled: devPasswordLogin },
	plugins: [
		// Stable signing key for access/ID tokens + /jwks (required by mcp()).
		jwt(),
		// mcp() *is* the OAuth 2.1 provider — never also register oauthProvider().
		mcp({
			resource: mcpResource,
			loginPage: '/login',
			consentPage: '/consent',
			// OAuth scopes are exactly Skiff's RBAC permissions (packages/contracts).
			scopes: ['openid', 'profile', 'email', 'offline_access', ...allPermissions],
			// CIMD is the MCP 2026-07-28 mechanism; DCR stays available for older clients.
			allowDynamicClientRegistration: allowDcr,
			allowUnauthenticatedClientRegistration: allowDcr,
			clientRegistrationDefaultApplicationType: 'infer',
		}),
		// Client ID Metadata Documents. The Node transport resolves DNS once, rejects
		// special-use addresses, pins the IP and refuses redirects — verified under Bun
		// in spikes/cimd-bun.
		cimd({ fetchClientMetadataResource, metadataProfile: 'mcp-2026-07-28' }),
		// Must be last: lets server-side auth calls set cookies through SvelteKit.
		sveltekitCookies(getRequestEvent),
	],
});

export type Session = typeof auth.$Infer.Session;
